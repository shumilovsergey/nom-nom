package main

// auth-human.go — browser ↔ auth-center authentication.
// Handles the human-facing auth flow: redirect to auth-center, receive the
// one-time code, exchange it server-side, issue a JWT session cookie.
// This file should not need changes between apps built on this template.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var jwtSecret []byte

type jwtClaims struct {
	UserID int64 `json:"uid"`
	jwt.RegisteredClaims
}

func setSession(w http.ResponseWriter, userID int64) {
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwtClaims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(30 * 24 * time.Hour)),
		},
	})
	signed, err := token.SignedString(jwtSecret)
	if err != nil {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    signed,
		Path:     "/",
		MaxAge:   86400 * 30,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

func clearSession(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:   "session",
		Value:  "",
		Path:   "/",
		MaxAge: -1,
	})
}

// sessionUserID validates the JWT cookie and returns the internal user ID,
// or 0 if absent or invalid.
func sessionUserID(r *http.Request) int64 {
	cookie, err := r.Cookie("session")
	if err != nil {
		return 0
	}
	var c jwtClaims
	token, err := jwt.ParseWithClaims(cookie.Value, &c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return 0
	}
	return c.UserID
}

// requireAuth is middleware that redirects unauthenticated requests to /login.
func requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if sessionUserID(r) == 0 {
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, authURL+"/?redirect="+appURL+"/", http.StatusFound)
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if uid := sessionUserID(r); uid != 0 {
		log.Printf("logout uid=%d", uid)
	}
	clearSession(w)
	http.Redirect(w, r, "/", http.StatusFound)
}

// handleCallback exchanges the one-time code with auth-center, upserts the user
// in the DB, sets a JWT cookie, and redirects to /.
func handleCallback(w http.ResponseWriter, r *http.Request, code string) {
	body, _ := json.Marshal(map[string]string{
		"code":      code,
		"app_token": appToken,
	})
	resp, err := httpClient.Post(authInternal+"/exchange", "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("exchange: %v", err)
		http.Error(w, "could not reach auth center", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	var data struct {
		Ok     bool           `json:"ok"`
		Method string         `json:"method"`
		User   map[string]any `json:"user"`
		Error  string         `json:"error"`
	}
	json.NewDecoder(resp.Body).Decode(&data) //nolint:errcheck

	if !data.Ok {
		log.Printf("login error exchange: %s", data.Error)
		http.Error(w, "auth failed: "+data.Error, http.StatusForbidden)
		return
	}

	authID := extractAuthID(data.User)
	name := extractName(data.User, data.Method)
	uid, isNew, err := upsertUser(authID, data.Method, name)
	if err != nil {
		log.Printf("login error upsert: %v", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	log.Printf("login uid=%d method=%s name=%q new=%v", uid, data.Method, name, isNew)

	setSession(w, uid)
	http.Redirect(w, r, "/", http.StatusFound)
}

// extractAuthID returns the permanent user ID string from the auth-center user
// map. Telegram returns a numeric float64; Solana and Google return strings.
func extractAuthID(user map[string]any) string {
	switch v := user["id"].(type) {
	case float64:
		return fmt.Sprintf("%.0f", v)
	case string:
		return v
	}
	return ""
}

// extractName builds a display name from the auth-center user map.
func extractName(user map[string]any, method string) string {
	if method == "google" {
		if n, ok := user["name"].(string); ok {
			return n
		}
	}
	var parts []string
	for _, k := range []string{"first_name", "last_name"} {
		if s, ok := user[k].(string); ok && s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, " ")
}
