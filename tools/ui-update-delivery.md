# UI update delivery (cache-busting)

How a browser picks up **new** `style.css` / `script.js` after a deploy, instead of running
the old cached copy. This is a **reusable pattern** — it works in any app in the ecosystem
because they all share the convention: **every binary carries a build stamp exposed via
`--version`.** That same stamp doubles as the cache-bust token, so there is nothing new to
add per app.

## The problem in one sentence

Browsers cache static files **by URL**. If `/script.js` looks like the same URL as yesterday,
the browser reuses yesterday's copy and never asks the server — so a fresh deploy never
reaches the user until they hard-refresh (Cmd+Shift+R). We can't ask every production user to
do that.

## The fix: change the URL when the file changes

Cache the assets **hard and long**, but append a per-deploy token to their URL so the browser
is *forced* to treat them as new files after every release:

```html
<link rel="stylesheet" href="/style.css?v={{.Version}}" />
<script src="/script.js?v={{.Version}}"></script>
```

`{{.Version}}` is the build stamp. When it changes, the URL changes, the cache misses, the
browser fetches the new file. Between deploys the URL is stable, so repeat loads stay instant.

This only works as a **pair of rules** — one without the other does nothing:

| Response | `Cache-Control` | Why |
|---|---|---|
| **HTML** (the page) | `no-cache` | Always revalidated, so it always carries the *current* `?v=` token. If the HTML is cached, the browser keeps handing out stale asset URLs. |
| **Assets** (css/js/svg) | `public, max-age=2592000, immutable` | Cache 30 days and never revalidate — safe *because* the URL changes on deploy. |

> Caching assets hard **without** the `?v=` token is the trap: users get stuck on old files
> with no way to update short of a hard refresh. That is exactly the bug this pattern fixes.

## The token = the build stamp (`--version`)

Every binary already bakes a build stamp in at link time and prints it via `--version`. Reuse
it as the token — **do not invent a separate versioning scheme.**

**Dockerfile** — inject the stamp at build:

```dockerfile
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) && \
go build -ldflags="-s -w -X main.buildTime=${BUILD_TIME}" ...
```

**`main.go`** — the same var backs both `--version` and the template:

```go
var buildTime = "unknown" // set via -ldflags at build; "unknown" in local dev

// --version / --info
fmt.Printf("<app> built: %s\n", buildTime)

// page render
w.Header().Set("Cache-Control", "no-cache")           // HTML always revalidates
tmpl.Execute(w, pageData{User: user, Version: buildTime})
```

`pageData` gains a `Version string` field; the static routes are wrapped in a helper that sets
the long-immutable header:

```go
func cacheStatic(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=2592000, immutable")
		h.ServeHTTP(w, r)
	})
}

mux.Handle("GET /style.css", cacheStatic(fileServer))
mux.Handle("GET /script.js", cacheStatic(fileServer))
mux.Handle("GET /favicon.svg", cacheStatic(fileServer))
```

## Result

Every `prod-compose run release` bakes a new `buildTime` → new `?v=` on every asset URL →
each user's browser fetches the new files on their **next page load**. No manual refresh, no
Dockerfile changes beyond the stamp that already exists for `--version`.

## Notes & limits

- **Local dev**: ldflags only run in the Docker build, so `buildTime` is `"unknown"` and the
  token is static. You'll still Cmd+R during hot-reload — that's fine, only prod needed fixing.
- **Delivers on next *navigation***: a page a user left **open** keeps running the old JS until
  they reload or reopen the tab. Closing that gap (auto-reloading long-lived tabs) is a separate
  mechanism — a client that polls the server's `buildTime` and calls `location.reload()` when it
  changes — built on top of this one. See the 24h-refresh design.
- **You cannot force a hard/cache-bypassing reload from JS.** There is no browser API for it.
  `location.reload()` only delivers new code *because* this pattern changed the asset URL — the
  two are a pair.

## Checklist to add this to a new app

1. Dockerfile injects `-X main.buildTime=$(date -u ...)` (already present if `--version` works).
2. `pageData` has a `Version string` field.
3. Page handler: set `Cache-Control: no-cache`, pass `Version: buildTime`.
4. Static routes wrapped in `cacheStatic` (`max-age=2592000, immutable`).
5. Template asset tags use `?v={{.Version}}`.
