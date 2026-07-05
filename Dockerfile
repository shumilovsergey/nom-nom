# ── dev: hot-reload with Air ──────────────────────────────────────────────
FROM golang:1.23-bookworm AS dev
WORKDIR /app
RUN go install github.com/air-verse/air@v1.52.3
ENV GONOSUMDB=* GOFLAGS=-mod=mod
EXPOSE 8890
CMD ["air"]

# ── builder: compiles linux/amd64 binary ─────────────────────────────────
FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY build/ .
RUN go mod tidy && \
    BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w -X main.buildTime=${BUILD_TIME}" \
    -o /nom-nom .
