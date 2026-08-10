#!/usr/bin/env bash
# Start Scout. One command, from nothing to a working URL.
#
# Does whatever is missing and skips whatever is not: starts Postgres if it is
# not up, applies migrations if they are pending, seeds if the database is
# empty, then runs the API and the dashboard together and does not print the
# URL until both actually answer.
#
# Ctrl-C stops both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_DIR="${TMPDIR:-/tmp}/scout-run"
mkdir -p "$RUN_DIR"
API_LOG="$RUN_DIR/api.log"
WEB_LOG="$RUN_DIR/web.log"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m !\033[0m %s\n' "$1"; }
die()  { printf '\033[31m ✗\033[0m %s\n' "$1" >&2; exit 1; }

API_PORT="${PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"
WATCH_EVERY="${SCOUT_WATCH_SECONDS:-10}"

# ── config ─────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  step "Creating .env from .env.example"
  cp .env.example .env
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set in .env"

# ── ports ──────────────────────────────────────────────────────────────────
# A stale server from an earlier run is the single most common reason this
# script appears to work while the browser shows something else entirely.
# Who is listening on a port.
#
# Every method is tried and the results are combined, rather than taking the
# first tool that happens to be installed. `lsof` is present in some containers
# but returns nothing and exits 0 — indistinguishable from "the port is free"
# if it is the only thing consulted. That silent empty answer is what let a
# stale server keep a port while this script reported it clear, and then failed
# to start on top of it.
port_pids() {
  local port="$1" pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids="$pids $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if command -v fuser >/dev/null 2>&1; then
    pids="$pids $(fuser "$port/tcp" 2>/dev/null | tr -s ' ' '\n' || true)"
  fi
  if command -v ss >/dev/null 2>&1; then
    pids="$pids $(ss -lptnH "sport = :$port" 2>/dev/null \
      | grep -oE 'pid=[0-9]+' | cut -d= -f2 || true)"
  fi

  # Last resort: read it out of /proc. Node is guaranteed present here — it is
  # what the app runs on — so this needs no extra dependency.
  if [ -z "$(printf '%s' "$pids" | tr -d '[:space:]')" ] && [ -r /proc/net/tcp ]; then
    pids="$pids $(node -e '
      const fs = require("fs"), port = Number(process.argv[1]);
      const inodes = new Set();
      for (const line of fs.readFileSync("/proc/net/tcp", "utf8").split("\n").slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10) continue;
        if (parseInt(f[1].split(":")[1], 16) === port && f[3] === "0A") inodes.add(f[9]);
      }
      if (inodes.size === 0) process.exit(0);
      const out = new Set();
      for (const pid of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        let fds; try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
        for (const fd of fds) {
          let link; try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
          const m = /^socket:\[(\d+)\]$/.exec(link);
          if (m && inodes.has(m[1])) { out.add(pid); break; }
        }
      }
      console.log([...out].join("\n"));
    ' "$port" 2>/dev/null || true)"
  fi

  printf '%s' "$pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
}

# Frees a port and does not return until it is actually free.
#
# `pnpm run dev` is a wrapper: it spawns the real server as a grandchild, so
# killing the pid this script holds leaves `next-server` alive and still
# holding the port. Everything here therefore works from "who is listening",
# not from "who did I start", and escalates to SIGKILL rather than assuming
# SIGTERM was honoured. Getting this wrong is what made a retry leave one
# server running on a build directory the retry had just deleted.
free_port() {
  local port="$1" pids
  pids="$(port_pids "$port")"
  [ -n "$pids" ] || return 0

  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5 6; do
    sleep 0.5
    [ -z "$(port_pids "$port")" ] && return 0
  done

  pids="$(port_pids "$port")"
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  for _ in 1 2 3 4; do
    sleep 0.5
    [ -z "$(port_pids "$port")" ] && return 0
  done
  return 1
}

for port in "$API_PORT" "$WEB_PORT"; do
  if [ -n "$(port_pids "$port")" ]; then
    warn "Port $port is already in use. Stopping what is on it."
    free_port "$port" || die "Could not free port $port. Stop it by hand and re-run."
  fi
done

# ── dependencies ───────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  step "Installing dependencies"
  pnpm install
fi

# ── database ───────────────────────────────────────────────────────────────
# `prisma db execute --stdin` needs --url or --schema; without one it exits 1
# with a usage error, which a `>/dev/null 2>&1` probe reads as "unreachable".
# It therefore reported every healthy database as down and shelled out to start
# a cluster that was already running.
db_reachable() {
  pnpm --filter @scout/db exec prisma db execute \
    --url "$DATABASE_URL" --stdin <<<"SELECT 1;" >/dev/null 2>&1
}

step "Checking the database"
if db_reachable; then
  printf '    reachable\n'
else
  warn "Not reachable — starting a local cluster"
  "$ROOT/scripts/dev-db.sh"
  db_reachable || die "Still cannot reach $DATABASE_URL after starting Postgres."
fi

pnpm --filter @scout/db exec prisma generate >/dev/null 2>&1

step "Applying migrations"
pnpm --filter @scout/db exec prisma migrate deploy 2>&1 \
  | grep -E "Applying|already in sync|No pending|successfully applied" || true

# Seed only an empty database. Re-seeding one that already has work in it would
# be a surprise, and a bad one. An unreadable count means "do not seed" rather
# than "seed anyway" for the same reason.
step "Checking for existing cases"
# `psql` is not necessarily on PATH — Homebrew's postgresql@NN is keg-only, so
# a Mac with Postgres correctly installed has no psql anywhere PATH can see.
# Calling it bare meant this probe silently produced nothing there, and an
# empty database was never seeded: you would open Scout to no cases at all and
# reasonably conclude it was broken.
# shellcheck source=lib/find-pg.sh
. "$ROOT/scripts/lib/find-pg.sh"
PSQL_DIR="$(find_pg_bin psql || true)"
PSQL="${PSQL_DIR:+$PSQL_DIR/}psql"

COUNT="$(pnpm --filter @scout/db exec prisma db execute --url "$DATABASE_URL" \
  --stdin <<<'SELECT count(*) FROM "Case";' >/dev/null 2>&1 \
  && "$PSQL" "${DATABASE_URL%%\?*}" -tAc 'SELECT count(*) FROM "Case";' 2>/dev/null \
  | tr -d '[:space:]')"
if [ "$COUNT" = "0" ]; then
  step "Seeding a demo case (database is empty)"
  pnpm --filter @scout/db run seed >/dev/null
else
  printf '    %s case(s) already here; not seeding\n' "${COUNT:-?}"
fi

# ── servers ────────────────────────────────────────────────────────────────
# Stops both servers for real: the wrappers this script started, and whatever
# is still listening afterwards. The second half is the one that matters —
# see the note on free_port.
stop_servers() {
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null || true
  free_port "$API_PORT" || true
  free_port "$WEB_PORT" || true
}

SHUTTING_DOWN=0
cleanup() {
  SHUTTING_DOWN=1
  printf '\n'
  step "Stopping"
  stop_servers
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

start_api() {
  pnpm --filter @scout/api run dev >"$API_LOG" 2>&1 &
  API_PID=$!
}

start_web() {
  pnpm --filter @scout/web run dev >"$WEB_LOG" 2>&1 &
  WEB_PID=$!
}

# `next dev` cannot run on top of a production build — it looks for dev
# manifests that `next build` never writes and fails with a wall of ENOENT that
# names none of this. BUILD_ID is only written by a production build, so its
# presence is the tell. Clearing here rather than discovering it through the
# retry keeps the common path fast and quiet.
if [ -f apps/web/.next/BUILD_ID ]; then
  step "Clearing a production build so the dev server can start"
  rm -rf apps/web/.next
fi

step "Starting the API on :$API_PORT"
start_api
step "Starting the dashboard on :$WEB_PORT"
start_web

ready() { curl -fsS -o /dev/null --max-time 3 "$1" 2>/dev/null; }

# A port answering is not the same as the app working. These three are what
# "started" actually means, and the script does not claim it until all three
# hold:
#
#   1. the API's own health endpoint is up
#   2. the dashboard serves its shell — not a 200 from a compile-error page
#   3. the API is reachable *through* the dashboard's /api proxy, which is the
#      path the browser actually uses
#
# Checking only (1) and (2) is how a broken proxy ships as "running".
api_ok() { ready "http://localhost:$API_PORT/health"; }

web_ok() {
  curl -fsS --max-time 5 "http://localhost:$WEB_PORT/" 2>/dev/null | grep -q "SCOUT"
}

proxy_ok() {
  curl -fsS --max-time 5 "http://localhost:$WEB_PORT/api/health" 2>/dev/null \
    | grep -q '"status":"ok"'
}

verify() { api_ok && web_ok && proxy_ok; }

await() {
  for _ in $(seq 1 "$1"); do
    if verify; then return 0; fi
    # A dead child will never become ready; fail fast rather than burn the
    # whole timeout waiting for a process that has already exited.
    kill -0 "$API_PID" 2>/dev/null || return 2
    kill -0 "$WEB_PID" 2>/dev/null || return 3
    sleep 1
  done
  return 1
}

step "Waiting for the app to actually answer"
await 90 && UP=1 || RC=$?

# One automatic retry with a cleared Next build directory. `next dev` after a
# `next build` — or after an interrupted compile — leaves state that makes it
# fail in ways whose error messages point nowhere useful. Clearing it is cheap
# and fixes the whole class, so the script tries that itself rather than
# printing a stack trace and giving up.
if [ "${UP:-0}" != "1" ]; then
  warn "Not answering yet. Clearing the Next build cache and retrying once."
  # Both servers must be genuinely gone before the build directory goes — a
  # surviving next-server whose .next has been deleted serves 500s forever and
  # holds the port the retry needs.
  stop_servers
  rm -rf apps/web/.next
  start_api
  start_web
  await 120 && UP=1 || RC=$?
fi

if [ "${UP:-0}" != "1" ]; then
  printf '\n'
  case "${RC:-1}" in
    2) warn "The API process exited. Its log:"; tail -30 "$API_LOG" ;;
    3) warn "The dashboard process exited. Its log:"; tail -30 "$WEB_LOG" ;;
    *) warn "Both processes are alive but the app never answered. Recent logs:"
       tail -15 "$API_LOG"; printf '  ── dashboard ──\n'; tail -15 "$WEB_LOG" ;;
  esac
  die "Scout did not come up. Logs above; nothing was left running."
fi

KEYED="$(curl -fsS "http://localhost:$API_PORT/health" \
  | sed -E 's/.*"keyed":([0-9]+).*/\1/')"

printf '\n'
bold "  Scout is running — verified, not assumed."
printf '\n'
bold "    →  http://localhost:$WEB_PORT"
printf '\n'
printf '  Open that URL. Include the port — the dashboard is not on port 80,\n'
printf '  and it proxies the API itself, so this is the only address you need.\n\n'
printf '  Checked   dashboard shell served · API healthy · /api proxy answering\n'
printf '  API       http://localhost:%s   (proxied at /api)\n' "$API_PORT"
printf '  Sources   %s of 19 keyed; the rest report "inert" rather than guessing\n' "${KEYED:-?}"
printf '  Logs      %s\n            %s\n' "$API_LOG" "$WEB_LOG"
printf '  Watchdog   checking every %ss; restarts either server if it stops\n' "$WATCH_EVERY"
printf '\n  Ctrl-C stops both.\n\n'

# ── watchdog ───────────────────────────────────────────────────────────────
# Starting the servers is not the same as keeping them running.
#
# A dev server can be killed out from under you — by an OOM reaper, by a
# process-group teardown, by a supervisor that owns the terminal — and when it
# happens there is no error anywhere: the log simply stops mid-request. The
# script used to `wait` here, so the servers were gone and the last thing on
# screen still said "Scout is running".
#
# Each check restarts only the half that is actually down, and one failed check
# is not an outage — a slow compile or a single dropped request should not
# trigger a restart, so it takes two consecutive failures.
strikes=0
while [ "$SHUTTING_DOWN" = "0" ]; do
  sleep "$WATCH_EVERY"
  [ "$SHUTTING_DOWN" = "1" ] && break

  if verify; then
    strikes=0
    continue
  fi

  strikes=$((strikes + 1))
  [ "$strikes" -lt 2 ] && continue

  if ! api_ok; then
    warn "The API stopped answering. Restarting it."
    free_port "$API_PORT" || true
    start_api
  fi
  if ! web_ok; then
    warn "The dashboard stopped answering. Restarting it."
    free_port "$WEB_PORT" || true
    start_web
  fi

  if await 90; then
    step "Back up."
    strikes=0
  else
    warn "Still down after a restart. Recent logs:"
    tail -12 "$API_LOG"; printf '  ── dashboard ──\n'; tail -12 "$WEB_LOG"
    strikes=0
  fi
done
