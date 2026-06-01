package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"ai-translation/auth-server/config"
	"ai-translation/auth-server/handler"
	"ai-translation/auth-server/mail"
	"ai-translation/auth-server/model"

	"github.com/golang-jwt/jwt/v5"
)

const (
	readTimeout  = 15 * time.Second
	writeTimeout = 30 * time.Second
	idleTimeout  = 60 * time.Second
	maxBodySize  = 1 << 20 // 1 MB
)

func cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !strings.HasPrefix(origin, "chrome-extension://") {
				http.Error(w, `{"error":"forbidden"}`, 403)
				return
			}
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(200)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
		next(w, r)
	}
}

func validateToken(r *http.Request, cfg *config.Config, db *model.DB) (string, jwt.MapClaims, bool) {
	tokenStr := r.Header.Get("Authorization")
	if tokenStr == "" {
		return "", nil, false
	}
	tokenStr = strings.TrimPrefix(tokenStr, "Bearer ")
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		return []byte(cfg.JWTSecret), nil
	})
	if err != nil || !token.Valid {
		return "", nil, false
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return "", nil, false
	}
	email, _ := claims["email"].(string)
	tokenVer, _ := claims["ver"].(float64)
	user, _ := db.FindByEmail(email)
	if user == nil || int(tokenVer) != user.TokenVersion {
		return "", nil, false
	}
	return tokenStr, claims, true
}

// Computed at startup, served from memory on every /api/version call.
type versionCache struct {
	Version     string `json:"version"`
	InstallHash string `json:"installHash"`
}

func main() {
	cfg := config.Load()

	db, err := model.NewDB(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("MySQL 连接失败: %v", err)
	}
	defer db.Close()

	if err := db.Migrate(); err != nil {
		log.Fatalf("数据库迁移失败: %v", err)
	}
	log.Println("数据库就绪")

	// Cache version + hash once at startup
	ver := strings.TrimSpace(string(func() []byte {
		d, _ := os.ReadFile("VERSION")
		return d
	}()))
	if ver == "" {
		ver = "1.0.0"
	}
	vc := versionCache{Version: ver}
	if data, err := os.ReadFile("installer.exe"); err == nil {
		h := sha256.Sum256(data)
		vc.InstallHash = hex.EncodeToString(h[:])
	}
	hashDisplay := "(none)"
	if len(vc.InstallHash) >= 16 {
		hashDisplay = vc.InstallHash[:16] + "..."
	}
	log.Printf("version cache: %s sha256=%s", vc.Version, hashDisplay)

	mailer := mail.New(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPUser, cfg.SMTPPassword)
	h := handler.New(cfg, db, mailer)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/send-code", cors(h.SendCode))
	mux.HandleFunc("/api/auth/login", cors(h.Login))
	mux.HandleFunc("/api/auth/me", cors(h.Me))
	mux.HandleFunc("/api/admin/set-plan", cors(h.SetPlan))
	mux.HandleFunc("/api/download/installer", func(w http.ResponseWriter, r *http.Request) {
		_, _, ok := validateToken(r, cfg, db)
		if !ok {
			http.Error(w, `{"error":"未登录或token无效"}`, 401)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=AI-Translation-Installer.exe")
		http.ServeFile(w, r, "installer.exe")
	})
	mux.HandleFunc("/api/version", cors(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		json.NewEncoder(w).Encode(vc)
	}))
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	})

	addr := fmt.Sprintf(":%s", cfg.Port)
	log.Printf("auth-server 启动在 %s", addr)

	// Cleanup expired codes / login failures every 10 minutes
	go func() {
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for range t.C {
			if err := db.CleanupExpiredCodes(); err != nil {
				log.Printf("清理过期验证码失败: %v", err)
			}
			if err := db.CleanupLoginFailures(); err != nil {
				log.Printf("清理登录失败记录失败: %v", err)
			}
		}
	}()

	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  readTimeout,
		WriteTimeout: writeTimeout,
		IdleTimeout:  idleTimeout,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("收到退出信号，正在优雅关闭...")
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("强制关闭: %v", err)
		}
		db.Close()
		log.Println("服务已关闭")
	}()

	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("服务启动失败: %v", err)
	}
}
