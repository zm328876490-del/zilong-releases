package handler

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"ai-translation/auth-server/config"
	"ai-translation/auth-server/mail"
	"ai-translation/auth-server/model"

	"github.com/golang-jwt/jwt/v5"
)

type Handler struct {
	cfg  *config.Config
	db   *model.DB
	mail *mail.Sender
}

func New(cfg *config.Config, db *model.DB, m *mail.Sender) *Handler {
	return &Handler{cfg: cfg, db: db, mail: m}
}

func jsonResp(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func genCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// POST /api/auth/send-code
func (h *Handler) SendCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		jsonResp(w, 405, map[string]string{"error": "POST required"})
		return
	}
	var req struct{ Email string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResp(w, 400, map[string]string{"error": "invalid json"})
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	if req.Email == "" || !strings.Contains(req.Email, "@") {
		jsonResp(w, 400, map[string]string{"error": "请输入有效邮箱"})
		return
	}
	code, err := genCode()
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "生成验证码失败"})
		return
	}
	if err := h.mail.SendCode(req.Email, code); err != nil {
		jsonResp(w, 500, map[string]string{"error": "发送邮件失败: " + err.Error()})
		return
	}
	if err := h.db.InsertCode(req.Email, code, 5*time.Minute); err != nil {
		jsonResp(w, 500, map[string]string{"error": "保存验证码失败"})
		return
	}
	jsonResp(w, 200, map[string]string{"ok": "验证码已发送"})
}

// POST /api/auth/login
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		jsonResp(w, 405, map[string]string{"error": "POST required"})
		return
	}
	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResp(w, 400, map[string]string{"error": "invalid json"})
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	req.Code = strings.TrimSpace(req.Code)
	if req.Email == "" || req.Code == "" {
		jsonResp(w, 400, map[string]string{"error": "邮箱和验证码不能为空"})
		return
	}
	ok, err := h.db.VerifyCode(req.Email, req.Code)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "服务器错误"})
		return
	}
	if !ok {
		jsonResp(w, 401, map[string]string{"error": "验证码错误或已过期"})
		return
	}
	user, err := h.db.UpsertUser(req.Email)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "登录失败"})
		return
	}
	token, err := h.signJWT(user)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "生成token失败"})
		return
	}
	jsonResp(w, 200, map[string]any{"token": token, "user": user})
}

// GET /api/auth/me
func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	token, err := h.extractToken(r)
	if err != nil {
		jsonResp(w, 401, map[string]string{"error": "未登录"})
		return
	}
	claims, err := h.parseJWT(token)
	if err != nil {
		jsonResp(w, 401, map[string]string{"error": "token无效或已过期"})
		return
	}
	email, _ := claims["email"].(string)
	user, err := h.db.FindByEmail(email)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "用户不存在"})
		return
	}
	jsonResp(w, 200, map[string]any{"user": user})
}

// PUT /api/admin/set-plan
func (h *Handler) SetPlan(w http.ResponseWriter, r *http.Request) {
	if r.Method != "PUT" {
		jsonResp(w, 405, map[string]string{"error": "PUT required"})
		return
	}
	token, err := h.extractToken(r)
	if err != nil {
		jsonResp(w, 401, map[string]string{"error": "未登录"})
		return
	}
	claims, err := h.parseJWT(token)
	if err != nil {
		jsonResp(w, 401, map[string]string{"error": "token无效"})
		return
	}
	operatorEmail, _ := claims["email"].(string)
	if operatorEmail != "329976490@qq.com" {
		jsonResp(w, 403, map[string]string{"error": "无权限"})
		return
	}
	var req struct {
		Email string `json:"email"`
		Plan  string `json:"plan"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResp(w, 400, map[string]string{"error": "invalid json"})
		return
	}
	if req.Plan != "trial" && req.Plan != "premium" {
		jsonResp(w, 400, map[string]string{"error": "plan must be trial or premium"})
		return
	}
	_, err = h.db.FindByEmail(req.Email)
	if err != nil {
		jsonResp(w, 404, map[string]string{"error": "用户不存在"})
		return
	}
	_, err = h.db.Exec(`UPDATE users SET plan=? WHERE email=?`, req.Plan, req.Email)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "更新失败"})
		return
	}
	jsonResp(w, 200, map[string]string{"ok": "已更新"})
}

func (h *Handler) signJWT(user *model.User) (string, error) {
	claims := jwt.MapClaims{
		"email": user.Email,
		"plan":  user.Plan,
		"iat":   time.Now().Unix(),
		"exp":   time.Now().Add(30 * 24 * time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(h.cfg.JWTSecret))
}

func (h *Handler) parseJWT(tokenStr string) (jwt.MapClaims, error) {
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		return []byte(h.cfg.JWTSecret), nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}

func (h *Handler) extractToken(r *http.Request) (string, error) {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return "", fmt.Errorf("no auth header")
	}
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", fmt.Errorf("bad auth format")
	}
	return strings.TrimPrefix(auth, "Bearer "), nil
}
