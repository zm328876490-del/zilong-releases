package mail

import (
	"crypto/tls"
	"fmt"
	"net"
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
	body := fmt.Sprintf("您的验证码是：<b>%s</b>，有效期 5 分钟。", code)
	msg := strings.Join([]string{
		"From: " + s.User,
		"To: " + to,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=UTF-8",
		"",
		body,
	}, "\r\n")

	addr := net.JoinHostPort(s.Host, s.Port)
	auth := smtp.PlainAuth("", s.User, s.Password, s.Host)

	// Try direct TLS (port 465) first
	tlsConfig := &tls.Config{ServerName: s.Host}
	conn, err := tls.Dial("tcp", addr, tlsConfig)
	if err != nil {
		// Fallback to STARTTLS (port 587)
		return smtp.SendMail(addr, auth, s.User, []string{to}, []byte(msg))
	}
	defer conn.Close()

	client, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		return fmt.Errorf("smtp new client: %w", err)
	}
	defer client.Quit()

	if err := client.Auth(auth); err != nil {
		return fmt.Errorf("smtp auth: %w", err)
	}
	if err := client.Mail(s.User); err != nil {
		return fmt.Errorf("smtp mail: %w", err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("smtp rcpt: %w", err)
	}
	wc, err := client.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := wc.Write([]byte(msg)); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := wc.Close(); err != nil {
		return fmt.Errorf("smtp close: %w", err)
	}
	return nil
}
