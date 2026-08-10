#!/usr/bin/env bash
# Stop Scout — everything it started, not just the process holding the lock.
#
# This exists because "stop it and start it again" was being done by hand with
# pkill, and hand-rolled teardown leaks. Over one working session it left
# fifteen orphaned start.sh instances and nineteen orphaned API processes
# behind, one of them running for eighteen hours, each with its own watchdog
# competing for the same two ports.
#
# The failure was not the lock in start.sh. It was that the lock could be
# stepped around by deleting its file, and nothing ever cleaned up a start.sh
# that had been SIGKILLed before its trap could run. So teardown belongs in one
# place that does it properly, and `pnpm start` calls it rather than trusting
# whoever went before.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_DIR="${TMPDIR:-/tmp}/scout-run"
LOCK="$RUN_DIR/start.pid"

API_PORT="${PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"

step() { printf '\033[36m==>\033[0m %s\n' "$1"; }

# Order matters: kill the supervisors first, or their watchdogs restart the
# servers being killed underneath them.
patterns=(
  "scripts/start.sh"
  "filter @scout/api run dev"
  "filter @scout/web run dev"
  "next dev -p ${WEB_PORT}"
)

stopped=0
for pattern in "${patterns[@]}"; do
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  [ -z "$pids" ] && continue
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  stopped=$((stopped + $(printf '%s\n' "$pids" | wc -w)))
done

# Give the traps a chance to run before insisting.
[ "$stopped" -gt 0 ] && sleep 2

for pattern in "${patterns[@]}"; do
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  [ -z "$pids" ] && continue
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
done

# Then whatever is still holding a port, whoever started it. This catches the
# grandchildren `pnpm run dev` spawns, which do not match any pattern above.
for port in "$API_PORT" "$WEB_PORT"; do
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && continue
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
done

rm -f "$LOCK"

if [ "$stopped" -gt 0 ]; then
  step "Stopped Scout ($stopped process(es))."
else
  step "Scout was not running."
fi
