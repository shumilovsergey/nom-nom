package main

import "fmt"

// app_db.go — app-specific database migrations for nom-nom (food scanner).
// initDB() (db.go) calls appMigrate() after the core users table is ready.
//
// Four tables back the whole app (see skeleton/db.md, skeleton/weight/db.md):
//   meal      — today's eaten meals (the donut SUMs these; the history table lists them)
//   favorite  — saved meal templates that PERSIST (never day-swept)
//   ai_usage  — one AI-request counter per user per MSK day (resets daily)
//   weights   — one weight entry per user per MSK day; PERSISTS (progress across all days)
//
// Per-user scan economy lives on the users row as three extra columns:
//   role             free | tester | pro
//   free_scans_left  lifetime free AI ops for a `free` user (FREE_SCANS, default 3)
//   daily_limit      AI ops/day for a `tester` (default 10)
//
// Personal daily targets (the donut's 100% mark, set via the gear sheet):
//   goal_kcal        calories/day  (default 2000)
//   goal_prot        protein g/day (default 120)

func appMigrate() error {
	// Extend the core users table. ALTER fallbacks are idempotent: harmless if the
	// column already exists (db.go owns the base table, so we add ours here).
	for _, alter := range []string{
		`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'free'`,
		`ALTER TABLE users ADD COLUMN free_scans_left INTEGER NOT NULL DEFAULT 3`,
		`ALTER TABLE users ADD COLUMN daily_limit INTEGER NOT NULL DEFAULT 10`,
		`ALTER TABLE users ADD COLUMN goal_kcal INTEGER NOT NULL DEFAULT 2000`,
		`ALTER TABLE users ADD COLUMN goal_prot INTEGER NOT NULL DEFAULT 120`,
	} {
		db.Exec(alter) //nolint:errcheck — ok if column already exists
	}

	// New users get freeScansDefault (FREE_SCANS) lifetime free AI ops. The INSERT
	// lives in db.go (shared infra, not ours to edit) and the column DEFAULT above is
	// baked in at CREATE time, so we apply the configured value with an AFTER INSERT
	// trigger, recreated on every boot to pick up the current env value. Existing rows
	// are untouched — changing FREE_SCANS only affects users who sign up afterwards.
	if _, err := db.Exec(fmt.Sprintf(`
		DROP TRIGGER IF EXISTS users_free_scans_default;
		CREATE TRIGGER users_free_scans_default AFTER INSERT ON users
		BEGIN
			UPDATE users SET free_scans_left = %d WHERE id = NEW.id;
		END;
	`, freeScansDefault)); err != nil {
		return err
	}

	_, err := db.Exec(`
		-- today's eaten meals. The donut SUMs these; the history table lists them.
		CREATE TABLE IF NOT EXISTS meal (
			id        INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id   INTEGER NOT NULL REFERENCES users(id),
			day       TEXT    NOT NULL,                          -- 'YYYY-MM-DD' MSK day (reset key)
			name      TEXT    NOT NULL,
			kcal      INTEGER NOT NULL,
			grams     INTEGER NOT NULL DEFAULT 0,
			prot      REAL    NOT NULL DEFAULT 0,
			fat       REAL    NOT NULL DEFAULT 0,
			carb      REAL    NOT NULL DEFAULT 0,
			eaten_at  TEXT    NOT NULL DEFAULT (datetime('now'))  -- newest-first ordering
		);
		CREATE INDEX IF NOT EXISTS idx_meal_user_day ON meal (user_id, day, eaten_at DESC);

		-- favorites library — saved meal templates. These PERSIST (no day, never swept).
		CREATE TABLE IF NOT EXISTS favorite (
			id      INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id),
			name    TEXT    NOT NULL,
			kcal    INTEGER NOT NULL,
			grams   INTEGER NOT NULL DEFAULT 0,
			prot    REAL    NOT NULL DEFAULT 0,
			fat     REAL    NOT NULL DEFAULT 0,
			carb    REAL    NOT NULL DEFAULT 0,
			UNIQUE (user_id, name)                               -- star upserts by name → no dupes
		);

		-- AI usage — one counter per user per MSK day. Photo + text count the same.
		CREATE TABLE IF NOT EXISTS ai_usage (
			user_id INTEGER NOT NULL,
			day     TEXT    NOT NULL,                            -- 'YYYY-MM-DD' MSK day
			uses    INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (user_id, day)
		);

		-- weight progress (skeleton/weight/db.md). One row per user per MSK day; the
		-- UNIQUE makes "today's weight" a clean upsert. NEVER day-swept — the whole
		-- point is the trend across days. Grams as INTEGER: no float rounding drift.
		CREATE TABLE IF NOT EXISTS weights (
			id          INTEGER PRIMARY KEY,
			user_id     INTEGER NOT NULL REFERENCES users(id),
			measured_on TEXT    NOT NULL,                        -- 'YYYY-MM-DD' MSK day
			weight_g    INTEGER NOT NULL,                        -- grams (83.1 kg = 83100)
			created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
			updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
			UNIQUE (user_id, measured_on)
		);
		CREATE INDEX IF NOT EXISTS idx_weights_user_date ON weights (user_id, measured_on DESC);
	`)
	return err
}
