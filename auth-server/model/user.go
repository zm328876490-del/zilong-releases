package model

import (
	"database/sql"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type User struct {
	ID           int64     `json:"id"`
	Email        string    `json:"email"`
	Plan         string    `json:"plan"`
	TokenVersion int       `json:"-"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
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
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)
	return &DB{db}, nil
}

func (db *DB) Migrate() error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id            BIGINT AUTO_INCREMENT PRIMARY KEY,
			email         VARCHAR(128) NOT NULL UNIQUE,
			plan          VARCHAR(16) NOT NULL DEFAULT 'trial',
			token_version INT NOT NULL DEFAULT 1,
			created_at    DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
			updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE IF NOT EXISTS verify_codes (
			id         BIGINT AUTO_INCREMENT PRIMARY KEY,
			email      VARCHAR(128) NOT NULL,
			code       VARCHAR(6) NOT NULL,
			created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
			expires_at DATETIME NOT NULL,
			used       TINYINT(1) NOT NULL DEFAULT 0,
			INDEX idx_email_created (email, created_at),
			INDEX idx_email_expires (email, expires_at)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		`CREATE TABLE IF NOT EXISTS login_failures (
			id         BIGINT AUTO_INCREMENT PRIMARY KEY,
			email      VARCHAR(128) NOT NULL,
			created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
			INDEX idx_lf_email_created (email, created_at)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	}
	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			return err
		}
	}
	// Safe migration: add token_version to existing table
	db.Exec(`ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 1`)
	db.Exec(`CREATE INDEX idx_vc_email_code_used ON verify_codes (email, code, used, expires_at)`)
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
		`SELECT id, email, plan, token_version, created_at, updated_at FROM users WHERE email=?`,
		email,
	).Scan(&u.ID, &u.Email, &u.Plan, &u.TokenVersion, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (db *DB) IncrementTokenVersion(email string) (int, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`UPDATE users SET token_version = token_version + 1 WHERE email=?`, email)
	if err != nil {
		return 0, err
	}
	var v int
	err = tx.QueryRow(`SELECT token_version FROM users WHERE email=?`, email).Scan(&v)
	if err != nil {
		return 0, err
	}
	return v, tx.Commit()
}

func (db *DB) CanSendCode(email string, cooldown time.Duration) (bool, error) {
	var count int
	err := db.QueryRow(
		`SELECT COUNT(*) FROM verify_codes WHERE email=? AND created_at > ?`,
		email, time.Now().UTC().Add(-cooldown),
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count == 0, nil
}

func (db *DB) InsertCode(email, code string, ttl time.Duration) error {
	_, err := db.Exec(
		`INSERT INTO verify_codes (email, code, expires_at) VALUES (?, ?, ?)`,
		email, code, time.Now().UTC().Add(ttl),
	)
	return err
}

func (db *DB) CleanupExpiredCodes() error {
	_, err := db.Exec(`DELETE FROM verify_codes WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 HOUR`)
	return err
}

func (db *DB) CanAttemptLogin(email string, maxFailures int, window time.Duration) (bool, error) {
	var count int
	err := db.QueryRow(
		`SELECT COUNT(*) FROM login_failures WHERE email=? AND created_at > ?`,
		email, time.Now().UTC().Add(-window),
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count < maxFailures, nil
}

func (db *DB) RecordLoginFailure(email string) error {
	_, err := db.Exec(`INSERT INTO login_failures (email) VALUES (?)`, email)
	return err
}

func (db *DB) CleanupLoginFailures() error {
	_, err := db.Exec(`DELETE FROM login_failures WHERE created_at < UTC_TIMESTAMP() - INTERVAL 1 HOUR`)
	return err
}

func (db *DB) VerifyCode(email, code string) (bool, error) {
	res, err := db.Exec(
		`UPDATE verify_codes SET used=1
		 WHERE email=? AND code=? AND expires_at > UTC_TIMESTAMP() AND used=0
		 ORDER BY id DESC LIMIT 1`,
		email, code,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (db *DB) InvalidateCodes(email string) error {
	_, err := db.Exec(`UPDATE verify_codes SET used=1 WHERE email=?`, email)
	return err
}
