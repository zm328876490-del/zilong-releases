package main

import (
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

func cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		// Allow chrome-extension:// origins and same-origin (no Origin header = curl/localhost)
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
		next(w, r)
	}
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

	mailer := mail.New(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPUser, cfg.SMTPPassword)
	h := handler.New(cfg, db, mailer)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/send-code", cors(h.SendCode))
	mux.HandleFunc("/api/auth/login", cors(h.Login))
	mux.HandleFunc("/api/auth/me", cors(h.Me))
	mux.HandleFunc("/api/admin/set-plan", cors(h.SetPlan))
	mux.HandleFunc("/api/download/installer", func(w http.ResponseWriter, r *http.Request) {
		// Validate premium token
		tokenStr := r.Header.Get("Authorization")
		if tokenStr == "" {
			http.Error(w, `{"error":"未登录"}`, 401)
			return
		}
		tokenStr = strings.TrimPrefix(tokenStr, "Bearer ")
		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
			return []byte(cfg.JWTSecret), nil
		})
		if err != nil || !token.Valid {
			http.Error(w, `{"error":"token无效"}`, 401)
			return
		}
		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok || claims["plan"] != "premium" {
			http.Error(w, `{"error":"需要高级版"}`, 403)
			return
		}
		// Serve dist.zip for the installer bootstrapper
		zipPath := os.Getenv("DIST_ZIP_PATH")
		if zipPath == "" {
			zipPath = "dist.zip"
		}
		w.Header().Set("Content-Type", "application/zip")
		http.ServeFile(w, r, zipPath)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	})

	addr := fmt.Sprintf(":%s", cfg.Port)
	log.Printf("auth-server 启动在 %s", addr)

	// Cleanup expired verify codes every 10 minutes
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

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("收到退出信号，关闭服务...")
		db.Close()
		os.Exit(0)
	}()

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
