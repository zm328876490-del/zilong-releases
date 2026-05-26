package model

import (
	"database/sql"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type User struct {
	ID        int64     `json:"id"`
	Email     string    `json:"email"`
	Plan      string    `json:"plan"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type DB struct {
	*sql.DB
}

func NewDB(dsn string) (*DB, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		return nil, err
	}
	return &DB{db}, nil
}

func (db *DB) Migrate() error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id         BIGINT AUTO_INCREMENT PRIMARY KEY,
			email      VARCHAR(128) NOT NULL UNIQUE,
			plan       VARCHAR(16) NOT NULL DEFAULT 'trial',
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE IF NOT EXISTS verify_codes (
			id         BIGINT AUTO_INCREMENT PRIMARY KEY,
			email      VARCHAR(128) NOT NULL,
			code       VARCHAR(6) NOT NULL,
			expires_at DATETIME NOT NULL,
			used       TINYINT(1) NOT NULL DEFAULT 0,
			INDEX idx_email_expires (email, expires_at)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	}
	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}

func (db *DB) UpsertUser(email string) (*User, error) {
	_, err := db.Exec(
		`INSERT INTO users (email) VALUES (?) ON DUPLICATE KEY UPDATE email=email`,
		email,
	)
	if err != nil {
		return nil, err
	}
	return db.FindByEmail(email)
}

func (db *DB) FindByEmail(email string) (*User, error) {
	u := &User{}
	err := db.QueryRow(
		`SELECT id, email, plan, created_at, updated_at FROM users WHERE email=?`,
		email,
	).Scan(&u.ID, &u.Email, &u.Plan, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (db *DB) InsertCode(email, code string, ttl time.Duration) error {
	_, err := db.Exec(
		`INSERT INTO verify_codes (email, code, expires_at) VALUES (?, ?, ?)`,
		email, code, time.Now().Add(ttl),
	)
	return err
}

func (db *DB) VerifyCode(email, code string) (bool, error) {
	var id int64
	err := db.QueryRow(
		`SELECT id FROM verify_codes
		 WHERE email=? AND code=? AND expires_at > NOW() AND used=0
		 ORDER BY id DESC LIMIT 1`,
		email, code,
	).Scan(&id)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	_, _ = db.Exec(`UPDATE verify_codes SET used=1 WHERE id=?`, id)
	return true, nil
}
