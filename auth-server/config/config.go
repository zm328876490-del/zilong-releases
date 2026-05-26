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
	return &Config{
		Port:         getEnv("PORT", "14532"),
		MySQLDSN:     getEnv("MYSQL_DSN", "root:root@tcp(127.0.0.1:3306)/auth_server?charset=utf8mb4&parseTime=true"),
		JWTSecret:    getEnv("JWT_SECRET", "change-me-in-production-2026"),
		SMTPHost:     "smtp.qq.com",
		SMTPPort:     "587",
		SMTPUser:     "329976490@qq.com",
		SMTPPassword: os.Getenv("SMTP_PASSWORD"),
	}
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
