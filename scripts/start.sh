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
port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$1/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
  fi
}

for port in "$API_PORT" "$WEB_PORT"; do
  pids="$(port_pids "$port")"
  if [ -n "$pids" ]; then
    warn "Port $port is already in use (pid $(echo "$pids" | tr '\n' ' ')). Stopping it."
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 2
    [ -z "$(port_pids "$port")" ] || die "Could not free port $port. Stop it and re-run."
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
COUNT="$(pnpm --filter @scout/db exec prisma db execute --url "$DATABASE_URL" \
  --stdin <<<'SELECT count(*) FROM "Case";' >/dev/null 2>&1 \
  && psql "${DATABASE_URL%%\?*}" -tAc 'SELECT count(*) FROM "Case";' 2>/dev/null \
  | tr -d '[:space:]')"
if [ "$COUNT" = "0" ]; then
  step "Seeding a demo case (database is empty)"
  pnpm --filter @scout/db run seed >/dev/null
else
  printf '    %s case(s) already here; not seeding\n' "${COUNT:-?}"
fi

# ── servers ────────────────────────────────────────────────────────────────
cleanup() {
  printf '\n'
  step "Stopping"
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

step "Starting the API on :$API_PORT"
pnpm --filter @scout/api run dev >"$API_LOG" 2>&1 &
API_PID=$!

step "Starting the dashboard on :$WEB_PORT"
pnpm --filter @scout/web run dev >"$WEB_LOG" 2>&1 &
WEB_PID=$!

# Wait for both to actually answer. Printing a URL before the server is up is
# how someone ends up staring at a browser error and assuming the app is broken.
ready() { curl -fsS -o /dev/null --max-time 2 "$1" 2>/dev/null; }

step "Waiting for both to come up"
for _ in $(seq 1 90); do
  kill -0 "$API_PID" 2>/dev/null || { cat "$API_LOG"; die "The API exited. Log above."; }
  kill -0 "$WEB_PID" 2>/dev/null || { cat "$WEB_LOG"; die "The dashboard exited. Log above."; }
  if ready "http://localhost:$API_PORT/health" && ready "http://localhost:$WEB_PORT/"; then
    UP=1; break
  fi
  sleep 1
done
[ "${UP:-0}" = "1" ] || { tail -20 "$API_LOG" "$WEB_LOG"; die "Timed out waiting. Logs above."; }

KEYED="$(curl -fsS "http://localhost:$API_PORT/health" \
  | sed -E 's/.*"keyed":([0-9]+).*/\1/')"

printf '\n'
bold "  Scout is running."
printf '\n'
bold "    →  http://localhost:$WEB_PORT"
printf '\n'
printf '  Open that URL. Include the port — the dashboard is not on port 80,\n'
printf '  and it proxies the API itself, so this is the only address you need.\n\n'
printf '  API      http://localhost:%s   (proxied at /api)\n' "$API_PORT"
printf '  Sources  %s of 19 keyed; the rest report "inert" rather than guessing\n' "${KEYED:-?}"
printf '  Logs     %s\n           %s\n' "$API_LOG" "$WEB_LOG"
printf '\n  Ctrl-C stops both.\n\n'

wait
