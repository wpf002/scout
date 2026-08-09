#!/usr/bin/env bash
# One-shot local setup: deps, env file, database, client, migrations, seed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Installing dependencies"
pnpm install

if [ ! -f .env ]; then
  echo "==> Creating .env from .env.example"
  cp .env.example .env
else
  echo "==> .env already exists, leaving it alone"
fi

# shellcheck disable=SC1091
set -a; [ -f .env ] && . ./.env; set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set in .env" >&2
  exit 1
fi

echo "==> Checking database connectivity"
if ! pnpm --filter @scout/db exec prisma db execute --stdin <<<"SELECT 1;" \
  >/dev/null 2>&1; then
  echo "    Not reachable. Starting a local cluster."
  "$ROOT/scripts/dev-db.sh"
fi

echo "==> Generating Prisma client"
pnpm --filter @scout/db exec prisma generate

echo "==> Applying migrations"
pnpm --filter @scout/db exec prisma migrate deploy

echo "==> Seeding demo case"
pnpm --filter @scout/db run seed

echo "==> Building"
# NODE_ENV must be `production` for this one command.
#
# `.env` sets NODE_ENV=development and the block above exports it, which is
# right for everything else here — but `next build` under NODE_ENV=development
# fails prerendering the 404 page with "<Html> should not be imported outside
# of pages/_document", an error that names nothing you wrote and sends you
# looking for a file this app does not have.
#
# Scoped to the build so the rest of the script keeps the developer defaults.
NODE_ENV=production pnpm build

echo
echo "Ready. Start the API with:  pnpm --filter @scout/api dev"
echo "Then:                       curl -s localhost:3001/health | jq"
