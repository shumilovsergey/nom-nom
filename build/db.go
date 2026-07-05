package main

// db.go — core database setup.
// The users table is the minimum required for any app using auth-center.
// App-specific tables go in app_db.go.

import (
	"database/sql"
	"log"
	"os"
	"time"

	_ "modernc.org/sqlite"
)

var db *sql.DB

// User is the core user record. Auth-center is the source of AuthID and Method;
// the app owns everything else (added via app_db.go migrations).
type User struct {
	ID        int64
	AuthID    string
	Method    string
	Name      string
	CreatedAt time.Time
	LastLogin time.Time
}

func initDB() {
	path := os.Getenv("DB_PATH")
	if path == "" {
		path = "auth-client.db"
	}
	var err error
	db, err = sql.Open("sqlite", path)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS users (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		auth_id    TEXT    NOT NULL UNIQUE,
		method     TEXT    NOT NULL,
		name       TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_login DATETIME
	)`)
	if err != nil {
		log.Fatalf("db migrate users: %v", err)
	}
	// add last_login to databases created before this column existed
	db.Exec(`ALTER TABLE users ADD COLUMN last_login DATETIME`) //nolint:errcheck
	if err := appMigrate(); err != nil {
		log.Fatalf("db migrate app: %v", err)
	}
}

// upsertUser inserts a new user or updates name/method/last_login on re-login.
// Returns the internal user ID and whether this is the first login.
func upsertUser(authID, method, name string) (int64, bool, error) {
	var exists bool
	db.QueryRow(`SELECT EXISTS(SELECT 1 FROM users WHERE auth_id = ?)`, authID).Scan(&exists) //nolint:errcheck

	_, err := db.Exec(`
		INSERT INTO users (auth_id, method, name, last_login)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(auth_id) DO UPDATE SET
			method     = excluded.method,
			name       = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END,
			last_login = CURRENT_TIMESTAMP
	`, authID, method, name)
	if err != nil {
		return 0, false, err
	}
	var id int64
	err = db.QueryRow(`SELECT id FROM users WHERE auth_id = ?`, authID).Scan(&id)
	return id, !exists, err
}

func getUserByID(id int64) (*User, error) {
	u := &User{}
	err := db.QueryRow(
		`SELECT id, auth_id, method, name, created_at, last_login FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.AuthID, &u.Method, &u.Name, &u.CreatedAt, &u.LastLogin)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}
