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

# Finding the server binaries.
#
# `initdb` on PATH is the exception, not the rule. Homebrew's postgresql@NN is
# keg-only, so a Mac with Postgres properly installed still has no `initdb`
# anywhere PATH can see it — searching PATH alone reports "not installed" to
# people who installed it. Postgres.app hides them somewhere else again, and
# Debian keeps them under a version directory.
#
# Newest version first in each location, so a machine carrying several does not
# get an ancient one by directory-listing order.
PGBIN=""
find_pgbin() {
  local dir
  for dir in "$@"; do
    [ -x "$dir/initdb" ] && PGBIN="$dir" && return 0
  done
  return 1
}

# shellcheck disable=SC2012
newest() { ls -d $1 2>/dev/null | sort -Vr; }

if command -v initdb >/dev/null 2>&1; then
  PGBIN="$(dirname "$(command -v initdb)")"
else
  case "$(uname -s)" in
    Darwin)
      BREW_PREFIX="$(brew --prefix 2>/dev/null || echo /opt/homebrew)"
      # shellcheck disable=SC2046
      find_pgbin \
        $(newest "$BREW_PREFIX/opt/postgresql@*/bin") \
        $(newest "/opt/homebrew/opt/postgresql@*/bin") \
        $(newest "/usr/local/opt/postgresql@*/bin") \
        $(newest "/Applications/Postgres.app/Contents/Versions/*/bin") \
        "$BREW_PREFIX/bin" || true
      ;;
    *)
      # shellcheck disable=SC2046
      find_pgbin $(newest "/usr/lib/postgresql/*/bin") || true
      ;;
  esac
fi

if [ -z "$PGBIN" ]; then
  echo "No Postgres server binaries found (looked for initdb)." >&2
  echo >&2
  case "$(uname -s)" in
    Darwin)
      echo "  brew install postgresql@16" >&2
      echo >&2
      echo "That formula is keg-only, so initdb will not land on your PATH —" >&2
      echo "this script looks in Homebrew's opt directory for exactly that reason," >&2
      echo "so no further setup is needed after the install." >&2
      ;;
    *)
      echo "  sudo apt-get install postgresql        # Debian/Ubuntu" >&2
      echo "  sudo dnf install postgresql-server     # Fedora/RHEL" >&2
      ;;
  esac
  echo >&2
  echo "Already have a server somewhere? Point DATABASE_URL at it in .env" >&2
  echo "and this script is skipped entirely." >&2
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
