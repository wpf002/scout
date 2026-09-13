#!/usr/bin/env bash
# The console walk in CI: migrate, seed the synthetic case, run the
# resolution service and the API, resolve the case so the review queue has
# pairs, run the web, then Playwright. Everything it starts is stopped on
# exit. Logs go to /tmp/scout-ci for the failure artifact.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS=/tmp/scout-ci
mkdir -p "$LOGS"
cd "$ROOT"

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

wait_for() { # url, seconds
  local url="$1" tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -sf -m 3 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "timed out waiting for $url" >&2
  return 1
}

echo "── migrate + seed ──"
pnpm --filter @scout/db exec prisma migrate deploy
pnpm --filter @scout/db run seed:v2

echo "── resolution service ──"
( cd services/resolution && uv sync --frozen --extra scoring && exec uv run --quiet uvicorn resolution.main:app --host 127.0.0.1 --port 8100 ) >"$LOGS/resolution.log" 2>&1 &
pids+=($!)
wait_for http://127.0.0.1:8100/healthz 90

echo "── api ──"
( cd apps/api && exec pnpm exec tsx src/index.ts ) >"$LOGS/api.log" 2>&1 &
pids+=($!)
wait_for http://localhost:3001/health 60

echo "── resolve the synthetic case so the review queue has pairs ──"
CASE_ID=$(curl -sf http://localhost:3001/cases | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).cases.find(c=>c.authorizationRef==="SYNTHETIC-DEV-0001");process.stdout.write(c?c.id:"")})')
[ -n "$CASE_ID" ] || { echo "synthetic case not found" >&2; exit 1; }
for kind in PERSON ORG; do
  curl -sf -m 600 -X POST http://localhost:3001/v2/resolve -H 'content-type: application/json' -d "{\"caseId\":\"$CASE_ID\",\"entityKind\":\"$kind\"}" >"$LOGS/resolve-$kind.json"
done

echo "── web ──"
( cd apps/web && exec pnpm run dev ) >"$LOGS/web.log" 2>&1 &
pids+=($!)
wait_for http://localhost:3000 120

echo "── playwright ──"
cd apps/web && pnpm exec playwright test console.spec.ts
