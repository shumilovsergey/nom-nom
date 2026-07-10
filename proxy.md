# AI Proxy Plan

Goal: route nom-nom's AI requests through our own **proxy-project** instead of calling
Anthropic directly. The proxy holds the real Anthropic key; nom-nom authenticates to the
proxy with a shared secret.

**Flow:** nom-nom → proxy (`POST /nom-nom-ai`, shared-secret auth) → Anthropic → back.

Right now `build/scan.go` `POST`s directly to `https://api.anthropic.com/v1/messages` with the
key in the `x-api-key` header. The proxy becomes a thin authenticated pass-through so nom-nom
never sees the real key.

---

## Proxy side (do this first)

### 1. Route

Add **`POST /nom-nom-ai`** — a thin authenticated pass-through to the Anthropic Messages API.

### 2. Auth (shared secret)

- Generate one strong secret: `openssl rand -hex 32`.
- Store on the proxy as env `NOM_NOM_SECRET`.
- Require it on every request via `Authorization: Bearer <secret>` (or a custom header like
  `X-Nom-Nom-Secret` — proxy dev's choice, just tell us which).
- Missing/wrong → return **`401`**, forward nothing upstream. Use constant-time comparison.

The same secret value later goes into nom-nom's env.

### 3. What nom-nom sends to the proxy

The request body is the **exact Anthropic Messages payload** — proxy treats it as opaque:

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 256,
  "system": "You are a nutrition expert...",
  "messages": [ { "role": "user", "content": [ ... ] } ]
}
```

- **Body can be large** — photo scans embed a base64 image in `content`. Allow **≥ ~10 MB** bodies.
- Forward the JSON body **byte-for-byte**; don't reshape it.

### 4. What the proxy does

For an authenticated request:

1. Take the raw request body.
2. `POST https://api.anthropic.com/v1/messages` with headers:
   - `Content-Type: application/json`
   - `x-api-key: <real ANTHROPIC_API_KEY, held only by the proxy>`
   - `anthropic-version: 2023-06-01`
3. Send the body unchanged.
4. **Return Anthropic's response as-is** — same status code, same body.

Do **not** swallow/rewrite errors. nom-nom inspects them:
- Treats **`402 Payment Required`** as "out of credits."
- Also looks for body `{"error":{"type":"billing_error"}}`.
Pass status + body straight through.

### 5. Timeouts

nom-nom bounds each call at **20s** and cancels on user abort. Proxy upstream timeout to
Anthropic should be **≥ 20s** (e.g. 30s). Photo scans on Opus legitimately take ~15s.

### 6. Proxy config

| Env var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Real Anthropic key — **lives only on the proxy now** |
| `NOM_NOM_SECRET` | Shared secret nom-nom must present to use `/nom-nom-ai` |

### 7. Self-test

```bash
# Should return 401 (no/incorrect secret)
curl -i -X POST https://<proxy-host>/nom-nom-ai -d '{}'

# Should return a real Anthropic response (200 + JSON)
curl -i -X POST https://<proxy-host>/nom-nom-ai \
  -H "Authorization: Bearer $NOM_NOM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-8","max_tokens":64,"messages":[{"role":"user","content":[{"type":"text","text":"say hi as JSON {\"ok\":true}"}]}]}'
```

**Deliverables from proxy dev:** (1) the proxy URL, (2) which auth header they chose.

---

## nom-nom side (do later, after proxy is confirmed working)

Small change to `build/scan.go`:
- Swap endpoint from `claudeAPI` to the proxy URL.
- Drop `x-api-key` and `anthropic-version` headers.
- Add the shared-secret header.
- Read new env: `AI_PROXY_URL` + `AI_PROXY_SECRET` (document in CLAUDE.md + `.env.example`).
- `ANTHROPIC_API_KEY` no longer needed in nom-nom once fully switched over.
