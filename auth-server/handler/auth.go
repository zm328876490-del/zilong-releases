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

	// Rate limit: 60s cooldown per email
	ok, err := h.db.CanSendCode(req.Email, 60*time.Second)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "服务器错误"})
		return
	}
	if !ok {
		jsonResp(w, 429, map[string]string{"error": "发送太频繁，请 60 秒后再试"})
		return
	}

	code, err := genCode()
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "生成验证码失败"})
		return
	}
	if err := h.mail.SendCode(req.Email, code); err != nil {
		// Dev fallback: log code to console when SMTP fails
		fmt.Printf("[DEV] 验证码发送失败(%s), 验证码: %s\n", err.Error(), code)
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
	canTry, err := h.db.CanAttemptLogin(req.Email, 5, 15*time.Minute)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "服务器错误"})
		return
	}
	if !canTry {
		jsonResp(w, 429, map[string]string{"error": "登录失败次数过多，请 15 分钟后再试"})
		return
	}
	ok, err := h.db.VerifyCode(req.Email, req.Code)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "服务器错误"})
		return
	}
	if !ok {
		_ = h.db.RecordLoginFailure(req.Email)
		jsonResp(w, 401, map[string]string{"error": "验证码错误或已过期"})
		return
	}
	user, err := h.db.UpsertUser(req.Email)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "登录失败"})
		return
	}
	ver, err := h.db.IncrementTokenVersion(req.Email)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "登录失败"})
		return
	}
	token, err := h.signJWT(user, ver)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "生成token失败"})
		return
	}
	jsonResp(w, 200, map[string]any{"token": token, "plan": user.Plan, "user": user})
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
	tokenVer, _ := claims["ver"].(float64)
	user, err := h.db.FindByEmail(email)
	if err != nil {
		jsonResp(w, 500, map[string]string{"error": "用户不存在"})
		return
	}
	if int(tokenVer) != user.TokenVersion {
		jsonResp(w, 401, map[string]string{"error": "已在其他设备登录，请重新登录"})
		return
	}
	jsonResp(w, 200, map[string]any{"plan": user.Plan, "user": user})
}

// PUT /api/admin/set-plan
// Admin (328876490@qq.com) can set any user's plan.
// Regular users can only upgrade themselves.
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
	tokenVer, _ := claims["ver"].(float64)

	operator, err := h.db.FindByEmail(operatorEmail)
	if err != nil {
		jsonResp(w, 404, map[string]string{"error": "用户不存在"})
		return
	}
	if int(tokenVer) != operator.TokenVersion {
		jsonResp(w, 401, map[string]string{"error": "已在其他设备登录，请重新登录"})
		return
	}
	isAdmin := operatorEmail == "328876490@qq.com"

	var req struct {
		Email string `json:"email"`
		Plan  string `json:"plan"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResp(w, 400, map[string]string{"error": "invalid json"})
		return
	}
	// Non-admin users can only upgrade themselves and only to premium
	if !isAdmin {
		if req.Email != operatorEmail {
			jsonResp(w, 403, map[string]string{"error": "只能升级自己的账号"})
			return
		}
		if req.Plan != "premium" {
			jsonResp(w, 403, map[string]string{"error": "只能升级到专业版"})
			return
		}
	} else {
		if req.Plan != "trial" && req.Plan != "premium" {
			jsonResp(w, 400, map[string]string{"error": "plan must be trial or premium"})
			return
		}
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

func (h *Handler) signJWT(user *model.User, ver int) (string, error) {
	claims := jwt.MapClaims{
		"email": user.Email,
		"plan":  user.Plan,
		"ver":   ver,
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
