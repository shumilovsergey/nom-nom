package main

// admin.go — tiny server-side CLI for managing the scan economy.
// Run inside the container or on the server, e.g.:
//   nom-nom --list-users
//   nom-nom --set-role  <auth_id> <free|tester|pro>
//   nom-nom --set-limit <auth_id> <n>     (tester daily AI ops)
//   nom-nom --grant-free <auth_id> <n>    (add lifetime free AI ops)

import (
	"fmt"
	"log"
	"strconv"
)

func runAdmin(args []string) {
	switch args[0] {
	case "--list-users":
		listUsersAdmin()
	case "--set-role":
		authID, val := adminArgs(args, "--set-role <auth_id> <free|tester|pro>")
		if val != "free" && val != "tester" && val != "pro" {
			log.Fatalf("invalid role %q (free|tester|pro)", val)
		}
		updateUser(authID, `UPDATE users SET role=? WHERE auth_id=?`, val, fmt.Sprintf("role=%s", val))
	case "--set-limit":
		authID, val := adminArgs(args, "--set-limit <auth_id> <n>")
		n := mustAtoi(val)
		updateUser(authID, `UPDATE users SET daily_limit=? WHERE auth_id=?`, n, fmt.Sprintf("daily_limit=%d", n))
	case "--grant-free":
		authID, val := adminArgs(args, "--grant-free <auth_id> <n>")
		n := mustAtoi(val)
		updateUser(authID, `UPDATE users SET free_scans_left = free_scans_left + ? WHERE auth_id=?`, n, fmt.Sprintf("free_scans_left += %d", n))
	default:
		log.Fatalf("unknown command %q (use --list-users, --set-role, --set-limit, --grant-free)", args[0])
	}
}

func adminArgs(args []string, usage string) (authID, val string) {
	if len(args) < 3 {
		log.Fatalf("usage: %s", usage)
	}
	return args[1], args[2]
}

func mustAtoi(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		log.Fatalf("invalid number %q", s)
	}
	return n
}

func updateUser(authID, query string, arg any, desc string) {
	res, err := db.Exec(query, arg, authID)
	if err != nil {
		log.Fatalf("update: %v", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fmt.Printf("user %q not found\n", authID)
		return
	}
	fmt.Printf("updated %s → %s\n", authID, desc)
}

func listUsersAdmin() {
	rows, err := db.Query(`
		SELECT id, auth_id, method, name, role, free_scans_left, daily_limit
		FROM users ORDER BY id`)
	if err != nil {
		log.Fatalf("list users: %v", err)
	}
	defer rows.Close()
	fmt.Printf("%-4s %-22s %-9s %-8s %-6s %-5s %s\n", "ID", "AUTH_ID", "METHOD", "ROLE", "FREE", "LIM", "NAME")
	for rows.Next() {
		var (
			id              int64
			authID, method  string
			name, role      string
			freeLeft, limit int
		)
		rows.Scan(&id, &authID, &method, &name, &role, &freeLeft, &limit) //nolint:errcheck
		fmt.Printf("%-4d %-22s %-9s %-8s %-6d %-5d %s\n", id, authID, method, role, freeLeft, limit, name)
	}
}
