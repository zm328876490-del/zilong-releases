package config

import "os"

type Config struct {
	Port string
	MySQLDSN  string
	JWTSecret string
	SMTPHost     string
	SMTPPort     string
	SMTPUser     string
	SMTPPassword string
}

func Load() *Config {
	cfg := &Config{
		Port:     getEnv("PORT", "14532"),
		MySQLDSN: getEnv("MYSQL_DSN", "root:rise@mysql@tcp(127.0.0.1:3306)/auth_server?charset=utf8mb4&parseTime=true&loc=UTC"),
		SMTPHost: "smtp.qq.com",
		SMTPPort: "465",
		SMTPUser: getEnv("SMTP_USER", "328876490@qq.com"),
	}
	cfg.JWTSecret = os.Getenv("JWT_SECRET")
	if cfg.JWTSecret == "" {
		panic("JWT_SECRET 环境变量未设置")
	}
	cfg.SMTPPassword = os.Getenv("SMTP_PASSWORD")
	if cfg.SMTPPassword == "" {
		panic("SMTP_PASSWORD 环境变量未设置")
	}
	return cfg
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
