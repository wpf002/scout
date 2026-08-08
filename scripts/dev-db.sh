#!/usr/bin/env bash
# Starts a throwaway local Postgres cluster for development.
#
# This exists so `bootstrap.sh` works on a machine that has the Postgres
# binaries but no running server. It is a dev convenience, not a deployment
# path — production uses a managed Postgres (Railway, Phase 8).
#
# Honours: PGPORT (default 5432), PGDATA (default depends on user, see below).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGPORT="${PGPORT:-5432}"

# Postgres refuses to run as root. When this script IS root — containers, CI —
# it drives the cluster as the `postgres` system user instead, and keeps the
# data directory inside that user's home so permissions are never a puzzle.
if [ "$(id -u)" -eq 0 ]; then
  PG_OWNER="${PG_OWNER:-postgres}"
  if ! id "$PG_OWNER" >/dev/null 2>&1; then
    echo "Running as root and there is no '$PG_OWNER' user to drop to." >&2
    echo "Create one, or run this script as a normal user." >&2
    exit 1
  fi
  PGDATA="${PGDATA:-/var/lib/postgresql/scout-dev}"
  as_pg() { su "$PG_OWNER" -s /bin/bash -c "$1"; }
else
  PG_OWNER="$(id -un)"
  PGDATA="${PGDATA:-$ROOT/.pgdata}"
  as_pg() { bash -c "$1"; }
fi

PGBIN=""
for dir in /usr/lib/postgresql/*/bin; do
  [ -x "$dir/initdb" ] && PGBIN="$dir" && break
done
if [ -z "$PGBIN" ] && command -v initdb >/dev/null 2>&1; then
  PGBIN="$(dirname "$(command -v initdb)")"
fi
if [ -z "$PGBIN" ]; then
  echo "No Postgres server binaries found (initdb)." >&2
  echo "Install postgresql, or point DATABASE_URL at an existing server." >&2
  exit 1
fi

mkdir -p "$PGDATA"
chown "$PG_OWNER" "$PGDATA" 2>/dev/null || true
chmod 700 "$PGDATA"

if [ ! -d "$PGDATA/base" ]; then
  echo "==> Initializing cluster at $PGDATA"
  as_pg "'$PGBIN/initdb' -D '$PGDATA' -U postgres --auth=trust" >/dev/null
fi

if as_pg "'$PGBIN/pg_ctl' -D '$PGDATA' status" >/dev/null 2>&1; then
  echo "==> Postgres already running"
else
  echo "==> Starting Postgres on port $PGPORT"
  as_pg "'$PGBIN/pg_ctl' -D '$PGDATA' \
    -o '-p $PGPORT -c listen_addresses=127.0.0.1' \
    -l '$PGDATA/server.log' -w start" >/dev/null
fi

if ! as_pg "'$PGBIN/psql' -h 127.0.0.1 -p $PGPORT -U postgres -Atqc \
  \"SELECT 1 FROM pg_database WHERE datname='scout'\"" | grep -q 1; then
  as_pg "'$PGBIN/createdb' -h 127.0.0.1 -p $PGPORT -U postgres scout"
  echo "==> Created database 'scout'"
fi

echo
echo "Postgres up. Set:"
echo "  DATABASE_URL=postgresql://postgres@127.0.0.1:$PGPORT/scout?schema=public"
echo
echo "Stop it with:"
echo "  ${SUDO:-}$PGBIN/pg_ctl -D $PGDATA stop"
