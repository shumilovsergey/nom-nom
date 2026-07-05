# nom-nom — CLI commands

All commands run the built binary (`bin/nom-nom`) **inside the container or on the
server** — they operate directly on the SQLite DB (`DB_PATH`), so run them where the DB
lives. With no arguments the binary starts the HTTP server.

## Info

| Command | Does |
|---|---|
| `nom-nom --version` | print the build timestamp and exit |
| `nom-nom --info` | same as `--version` |

## Admin (scan economy)

`<auth_id>` is the user's auth-center ID — the `AUTH_ID` column from `--list-users`
(shown as "Ваш ID" on the Credits screen).

| Command | Does |
|---|---|
| `nom-nom --list-users` | table of all users: ID, AUTH_ID, METHOD, ROLE, FREE, LIM, NAME |
| `nom-nom --set-role <auth_id> <free\|tester\|pro>` | set the user's role |
| `nom-nom --set-limit <auth_id> <n>` | set a **tester**'s daily AI-ops limit (`daily_limit`) |
| `nom-nom --grant-free <auth_id> <n>` | **add** `n` lifetime free AI ops to a **free** user (`free_scans_left += n`) |

## Examples

```bash
nom-nom --list-users
nom-nom --set-role  105993223363753461270 tester   # free | tester | pro
nom-nom --set-limit 105993223363753461270 20       # tester: 20 AI ops/day
nom-nom --grant-free 105993223363753461270 5       # free: +5 lifetime scans
```

## Role cheat-sheet

| Role | AI scans allowed |
|---|---|
| `free` | while `free_scans_left > 0` (lifetime, default 3) |
| `tester` | while today's uses < `daily_limit` (default 10, resets at MSK midnight) |
| `pro` | always |
