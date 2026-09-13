#!/usr/bin/env bash
# Scout v2 infrastructure bootstrap. Idempotent: run it as often as you like.
#
# What it does, in order, skipping whatever is already done:
#   1. Starts Postgres+PostGIS and MinIO from docker-compose.v2.yml.
#   2. Points .env's DATABASE_URL at the v2 database. The old line is kept in a
#      timestamped backup, and existing cases are copied across the first time
#      so nothing you had disappears.
#   3. Installs workspace dependencies and the two Python services.
#   4. Applies Prisma migrations and generates the client.
#   5. Seeds the synthetic resolution fixtures if the Observation table is empty.
#   6. Prints a health checklist and exits non-zero if any line fails.
#
# It never starts the API or the dashboard. That is scripts/start.sh's job,
# and one supervisor is enough.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m !\033[0m %s\n' "$1"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '   \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
die()  { printf '\033[31m ✗\033[0m %s\n' "$1" >&2; exit 1; }
FAILED=0

COMPOSE="docker compose -f docker-compose.v2.yml"
V2_URL="postgresql://scout:scout@127.0.0.1:5439/scout?schema=public"
V2_PLAIN="${V2_URL%%\?*}"

# ── 1. infrastructure ──────────────────────────────────────────────────────
command -v docker >/dev/null || die "Docker is required for v2 (PostGIS and MinIO). Install Docker Desktop and re-run."
docker info >/dev/null 2>&1 || die "Docker is installed but the daemon is not running."

step "Starting PostGIS and MinIO"
$COMPOSE up -d --wait --quiet-pull 2>&1 | grep -vE '^\s*$' || true

for _ in $(seq 1 30); do
  docker exec scout-v2-db pg_isready -U scout -d scout >/dev/null 2>&1 && break
  sleep 1
done
docker exec scout-v2-db pg_isready -U scout -d scout >/dev/null 2>&1 || die "Postgres did not become ready."

# ── 2. .env ────────────────────────────────────────────────────────────────
[ -f .env ] || cp .env.example .env
CURRENT_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- || true)"

if [ "$CURRENT_URL" != "$V2_URL" ]; then
  step "Pointing DATABASE_URL at the v2 database"
  BACKUP=".env.bak.$(date +%Y%m%d%H%M%S)"
  cp .env "$BACKUP"
  ok "previous .env kept at $BACKUP"

  # Copy existing data across once. A v1 database that is reachable and has
  # cases, and a v2 database with none, is the only situation that copies.
  # shellcheck source=lib/find-pg.sh
  . "$ROOT/scripts/lib/find-pg.sh"
  PGBIN="$(find_pg_bin pg_dump || true)"
  OLD_PLAIN="${CURRENT_URL%%\?*}"
  V2_CASES="$(docker exec scout-v2-db psql -U scout -d scout -tAc 'SELECT count(*) FROM "Case";' 2>/dev/null || echo "none")"
  if [ -n "$PGBIN" ] && [ -n "$OLD_PLAIN" ] && [ "$V2_CASES" = "none" ]; then
    OLD_CASES="$("$PGBIN/psql" "$OLD_PLAIN" -tAc 'SELECT count(*) FROM "Case";' 2>/dev/null || echo "")"
    if [ -n "$OLD_CASES" ] && [ "$OLD_CASES" != "0" ]; then
      step "Copying $OLD_CASES existing case(s) into the v2 database"
      "$PGBIN/pg_dump" --no-owner --no-acl "$OLD_PLAIN" \
        | docker exec -i scout-v2-db psql -q -U scout -d scout >/dev/null
      ok "copied"
    fi
  fi

  if grep -qE '^DATABASE_URL=' .env; then
    sed -i.tmp "s#^DATABASE_URL=.*#DATABASE_URL=${V2_URL}#" .env && rm -f .env.tmp
  else
    printf '\nDATABASE_URL=%s\n' "$V2_URL" >> .env
  fi
fi

# Every other v2 variable: add the example block once, without overwriting
# anything already set.
if ! grep -q '^S3_ENDPOINT=' .env; then
  step "Appending v2 variables from .env.v2.example"
  { printf '\n# ── v2 (added by scripts/bootstrap-v2.sh) ──\n'; grep -vE '^DATABASE_URL=' .env.v2.example; } >> .env
fi

set -a; . ./.env; set +a
export DATABASE_URL="$V2_URL"

# ── 3. dependencies ────────────────────────────────────────────────────────
step "Installing workspace dependencies"
pnpm install --frozen-lockfile --silent

if command -v uv >/dev/null 2>&1; then
  for svc in services/resolution services/recognition; do
    [ -f "$svc/pyproject.toml" ] || continue
    step "Syncing $svc"
    (cd "$svc" && uv sync --quiet)
  done
else
  warn "uv is not installed; skipping the Python services. https://docs.astral.sh/uv/"
fi

# ── 4. schema ──────────────────────────────────────────────────────────────
step "Applying migrations"
if ! MIGRATE_OUT="$(pnpm --filter @scout/db exec prisma migrate deploy 2>&1)"; then
  printf '%s\n' "$MIGRATE_OUT" | tail -20
  die "Migrations failed. The output above names the statement."
fi
printf '%s\n' "$MIGRATE_OUT" | grep -E "Applying|already in sync|No pending|successfully applied" || true
pnpm --filter @scout/db exec prisma generate >/dev/null 2>&1

# ── 5. fixtures ────────────────────────────────────────────────────────────
OBS="$(docker exec scout-v2-db psql -U scout -d scout -tAc 'SELECT count(*) FROM "Observation";' 2>/dev/null | tr -d '[:space:]' || echo "")"
if [ "$OBS" = "0" ]; then
  step "Seeding synthetic resolution fixtures (empty Observation table)"
  pnpm --filter @scout/db run seed:v2 >/dev/null
else
  ok "${OBS:-?} observation(s) already present; not seeding"
fi

# ── 6. checklist ───────────────────────────────────────────────────────────
printf '\n\033[1mv2 health\033[0m\n'

if docker exec scout-v2-db psql -U scout -d scout -tAc 'SELECT postgis_version();' >/dev/null 2>&1; then
  ok "Postgres + PostGIS on :5439 ($(docker exec scout-v2-db psql -U scout -d scout -tAc 'SELECT postgis_version();' | tr -d '[:space:]'))"
else bad "PostGIS not answering on :5439"; fi

if [ "$(pnpm --filter @scout/db exec prisma migrate status 2>/dev/null | grep -c 'Database schema is up to date')" = "1" ]; then
  ok "migrations applied"
else bad "migrations pending or unknown"; fi

if curl -fsS -m 5 http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
  ok "MinIO on :9000"
else bad "MinIO not answering on :9000"; fi

# Checked from inside the MinIO container, where `mc` and the `local` alias
# already exist. A separate mc container with --network host cannot reach the
# host's :9000 on Docker Desktop for Mac and reported every bucket missing.
docker exec scout-v2-minio mc alias set local http://127.0.0.1:9000 scout scout-minio-local >/dev/null 2>&1 || true
for b in scout-media scout-tiles; do
  if docker exec scout-v2-minio mc ls "local/$b" >/dev/null 2>&1; then
    ok "bucket $b"
  else bad "bucket $b missing"; fi
done

OBS="$(docker exec scout-v2-db psql -U scout -d scout -tAc 'SELECT count(*) FROM "Observation";' 2>/dev/null | tr -d '[:space:]' || echo 0)"
[ "${OBS:-0}" -gt 0 ] && ok "$OBS synthetic observations with ground truth" || bad "no fixtures seeded"

for svc in resolution recognition; do
  if [ -d "services/$svc/.venv" ]; then ok "services/$svc: dependencies synced (start with: cd services/$svc && uv run uvicorn $svc.main:app --port $([ "$svc" = resolution ] && echo 8100 || echo 8200))"
  else warn "services/$svc: not synced (uv missing?)"; fi
done

printf '\n'
if [ "$FAILED" = "1" ]; then die "One or more checks failed."; fi
printf '  \033[1mv2 infrastructure is ready.\033[0m  Run \033[1mpnpm start\033[0m as before.\n\n'
