package mail

import (
	"fmt"
	"net/smtp"
	"strings"
)

type Sender struct {
	Host     string
	Port     string
	User     string
	Password string
}

func New(host, port, user, password string) *Sender {
	return &Sender{Host: host, Port: port, User: user, Password: password}
}

func (s *Sender) SendCode(to, code string) error {
	subject := "AI 翻译插件 - 登录验证码"
	body := fmt.Sprintf(`您的验证码是：<b>%s</b>，有效期 5 分钟。`, code)
	msg := strings.Join([]string{
		"From: " + s.User,
		"To: " + to,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=UTF-8",
		"",
		body,
	}, "\r\n")
	addr := fmt.Sprintf("%s:%s", s.Host, s.Port)
	auth := smtp.PlainAuth("", s.User, s.Password, s.Host)
	return smtp.SendMail(addr, auth, s.User, []string{to}, []byte(msg))
}
