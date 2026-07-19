package main

import (
	"embed"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"
)

var buildTime = "unknown"

//go:embed web
var webFiles embed.FS

var (
	authURL      string
	authInternal string
	appURL       string
	appToken     string
	tmpl         *template.Template
	httpClient   = &http.Client{}
)

type pageData struct {
	User    *User
	Error   string
	Version string // buildTime — cache-bust token for static assets (?v=)
}

func initTemplate() {
	src, err := webFiles.ReadFile("web/index.html")
	if err != nil {
		log.Fatalf("web/index.html not found: %v", err)
	}
	tmpl = template.Must(template.New("index").Parse(string(src)))
}

// ── request logging ───────────────────────────────────────────────────────────

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(status int) {
	sw.status = status
	sw.ResponseWriter.WriteHeader(status)
}

func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Millisecond))
	})
}

// cacheStatic wraps a handler with a 30-day immutable cache header.
func cacheStatic(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=2592000, immutable") // 30 days; URL is busted per-deploy via ?v=
		h.ServeHTTP(w, r)
	})
}

// ── app routes ────────────────────────────────────────────────────────────────
// Add your app-specific handlers here.

func handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if code := r.URL.Query().Get("code"); code != "" {
		handleCallback(w, r, code)
		return
	}
	var user *User
	if uid := sessionUserID(r); uid != 0 {
		user, _ = getUserByID(uid)
	}
	// HTML must always revalidate so the fresh ?v= asset token reaches the browser.
	w.Header().Set("Cache-Control", "no-cache")
	tmpl.Execute(w, pageData{User: user, Version: buildTime}) //nolint:errcheck
}

// ── main ──────────────────────────────────────────────────────────────────────

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "--info") {
		fmt.Printf("nom-nom built: %s\n", buildTime)
		os.Exit(0)
	}

	log.SetFlags(log.Ldate | log.Ltime | log.LUTC)
	godotenv.Load() //nolint:errcheck

	authURL = os.Getenv("AUTH_URL")
	authInternal = os.Getenv("AUTH_INTERNAL")
	appURL = os.Getenv("APP_URL")
	appToken = os.Getenv("APP_TOKEN")

	secretKey := os.Getenv("SECRET_KEY")
	if secretKey == "" {
		secretKey = "dev-secret"
	}
	jwtSecret = []byte(secretKey)

	if m := os.Getenv("SCAN_MODEL"); m != "" {
		scanModel = m
	}

	aiProxyURL = os.Getenv("AI_PROXY_URL")
	aiProxySecret = os.Getenv("AI_PROXY_SECRET")

	initDB()

	// Admin CLI (run inside the container / on the server): nom-nom --set-role <auth_id> pro
	if len(os.Args) > 1 {
		runAdmin(os.Args[1:])
		return
	}

	initTemplate()

	webFS, _ := fs.Sub(webFiles, "web")
	fileServer := http.FileServer(http.FS(webFS))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", handleIndex)
	mux.HandleFunc("GET /login", handleLogin)
	mux.HandleFunc("GET /logout", handleLogout)
	mux.HandleFunc("GET /apps", handleOpenApps)
	mux.Handle("GET /favicon.svg", cacheStatic(fileServer))
	mux.Handle("GET /style.css", cacheStatic(fileServer))
	mux.Handle("GET /script.js", cacheStatic(fileServer))

	// nom-nom app API — all behind requireAuth (so sessionUserID is always set).
	api := func(h http.HandlerFunc) http.Handler { return requireAuth(h) }
	mux.Handle("GET /api/state", api(handleState))
	mux.Handle("POST /api/meal", api(handleMealAdd))
	mux.Handle("POST /api/meal/{id}", api(handleMealUpdate))
	mux.Handle("DELETE /api/meal/{id}", api(handleMealDelete))
	mux.Handle("POST /api/weight", api(handleWeightSet))
	mux.Handle("GET /api/weight/graph", api(handleWeightGraph))
	mux.Handle("POST /api/goals", api(handleGoalsSet))
	mux.Handle("POST /api/favorite", api(handleFavoriteAdd))
	mux.Handle("DELETE /api/favorite/{id}", api(handleFavoriteDelete))
	mux.Handle("POST /api/scan", api(handleScan))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8890"
	}
	log.Printf("listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, logMiddleware(mux)))
}
