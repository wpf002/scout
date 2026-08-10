#!/usr/bin/env bash
# Install Scout as a login service, so it is simply always there.
#
# One run of this and `pnpm start` never has to be typed again: Scout comes up
# when you log in, comes back if it dies, and survives a reboot.
#
#   ./scripts/install-autostart.sh            install and start it now
#   ./scripts/install-autostart.sh --status   is it installed, is it running
#   ./scripts/install-autostart.sh --uninstall remove it
#
# macOS gets a LaunchAgent, Linux a systemd user unit. Both run the same
# `scripts/start.sh` you would have run by hand, so there is one definition of
# what starting Scout means — a service that started it a *different* way would
# eventually drift from the one people actually test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="dev.scout.app"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m !\033[0m %s\n' "$1"; }
die()  { printf '\033[31m ✗\033[0m %s\n' "$1" >&2; exit 1; }

ACTION="install"
case "${1:-}" in
  --uninstall) ACTION="uninstall" ;;
  --status)    ACTION="status" ;;
  # Prints what would be installed, for a platform you may not be on. The
  # service files are the part most likely to be wrong and least likely to be
  # read, so they should be inspectable without committing to an install.
  --print)     ACTION="print" ;;
  "")          ACTION="install" ;;
  *)           die "Unknown option: $1 (try --status, --print or --uninstall)" ;;
esac

# A login service starts with almost no PATH, so every binary is resolved now
# and written in absolutely. "Works in my shell" is exactly the failure this
# avoids.
PNPM="$(command -v pnpm || true)"
[ -n "$PNPM" ] || die "pnpm is not on PATH. Install it, then re-run."
NODE_BIN_DIR="$(dirname "$(command -v node || echo /usr/local/bin/node)")"
LOG_DIR="${HOME}/.scout"
mkdir -p "$LOG_DIR"

# `systemctl --user` needs a live user D-Bus session. Containers and bare
# `su` shells often have systemd installed and no session bus at all, where it
# fails with "Failed to connect to bus: No medium found" — a message that names
# neither the cause nor the fix. Probe for it rather than discovering it three
# commands later.
user_systemd_works() {
  systemctl --user show-environment >/dev/null 2>&1
}

# systemd can be *installed* without being what actually boots the machine —
# common in containers, where PID 1 is something else entirely and every
# systemctl call fails with "System has not been booted with systemd as init
# system". /run/systemd/system exists only when systemd is genuinely running
# the show, so that is the honest question to ask.
systemd_is_init() {
  [ -d /run/systemd/system ]
}

case "$(uname -s)" in
  Darwin) PLATFORM="macos" ;;
  Linux)
    if ! command -v systemctl >/dev/null 2>&1 || ! systemd_is_init; then
      PLATFORM="unsupported"
    elif user_systemd_works; then
      PLATFORM="systemd"
    elif [ "$(id -u)" -eq 0 ]; then
      # No session bus, but we are root: a system unit does the same job and
      # does not depend on anyone being logged in.
      PLATFORM="systemd_system"
    else
      PLATFORM="unsupported"
    fi
    ;;
  *) PLATFORM="unsupported" ;;
esac

# ── macOS ──────────────────────────────────────────────────────────────────
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

macos_install() {
  mkdir -p "${HOME}/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ROOT}/scripts/start.sh</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/scout.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/scout.log</string>
</dict>
</plist>
PLIST_EOF

  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true
}

macos_uninstall() {
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST"
}

macos_status() {
  if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    echo "installed and loaded"
  else
    echo "not installed"
  fi
}

# ── systemd ────────────────────────────────────────────────────────────────
UNIT="${HOME}/.config/systemd/user/${LABEL}.service"

systemd_install() {
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Scout — tiered OSINT investigation platform
After=network.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
Environment=PATH=${NODE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin
ExecStart=${ROOT}/scripts/start.sh
Restart=always
RestartSec=5
StandardOutput=append:${LOG_DIR}/scout.log
StandardError=append:${LOG_DIR}/scout.log

[Install]
WantedBy=default.target
UNIT_EOF

  systemctl --user daemon-reload
  systemctl --user enable "${LABEL}.service" >/dev/null
  systemctl --user restart "${LABEL}.service"

  # Without lingering, a user unit stops the moment you log out — which would
  # make "it is always running" true only while you are sitting there.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER" 2>/dev/null \
      || warn "Could not enable lingering; Scout will stop when you log out. Run: sudo loginctl enable-linger $USER"
  fi
}

systemd_uninstall() {
  systemctl --user disable --now "${LABEL}.service" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
}

systemd_status() {
  systemctl --user is-active "${LABEL}.service" 2>/dev/null || echo "not running"
}

# ── systemd, system-wide ───────────────────────────────────────────────────
# Same unit, installed for the machine rather than for a login session. Used
# when there is no user session bus (containers, headless boxes) and we have
# the privileges for it.
SYS_UNIT="/etc/systemd/system/${LABEL}.service"

systemd_system_install() {
  cat > "$SYS_UNIT" <<UNIT_EOF
[Unit]
Description=Scout — tiered OSINT investigation platform
After=network.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=${ROOT}
Environment=PATH=${NODE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin
Environment=HOME=${HOME}
ExecStart=${ROOT}/scripts/start.sh
Restart=always
RestartSec=5
StandardOutput=append:${LOG_DIR}/scout.log
StandardError=append:${LOG_DIR}/scout.log

[Install]
WantedBy=multi-user.target
UNIT_EOF

  systemctl daemon-reload
  systemctl enable "${LABEL}.service" >/dev/null 2>&1 || true
  systemctl restart "${LABEL}.service"
}

systemd_system_uninstall() {
  systemctl disable --now "${LABEL}.service" 2>/dev/null || true
  rm -f "$SYS_UNIT"
  systemctl daemon-reload 2>/dev/null || true
}

systemd_system_status() {
  systemctl is-active "${LABEL}.service" 2>/dev/null || echo "not running"
}

# ── drive ──────────────────────────────────────────────────────────────────
if [ "$ACTION" = "print" ]; then
  printf '# macOS LaunchAgent → %s\n\n' "$PLIST"
  cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ROOT}/scripts/start.sh</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/scout.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/scout.log</string>
</dict>
</plist>
PLIST_EOF

  printf '\n# systemd user unit → %s\n\n' "$UNIT"
  cat <<UNIT_EOF
[Unit]
Description=Scout — tiered OSINT investigation platform
After=network.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
Environment=PATH=${NODE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin
ExecStart=${ROOT}/scripts/start.sh
Restart=always
RestartSec=5
StandardOutput=append:${LOG_DIR}/scout.log
StandardError=append:${LOG_DIR}/scout.log

[Install]
WantedBy=default.target
UNIT_EOF
  exit 0
fi

if [ "$PLATFORM" = "unsupported" ]; then
  if [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
    if ! systemd_is_init; then
      die "systemd is installed but is not running this machine (no /run/systemd/system),
   so nothing here can register a service. This is normal inside a container.
   Scout still runs in the foreground with: pnpm start"
    fi
    die "systemd is here but there is no user session bus, and this is not root.
   Either log in properly (so \`systemctl --user\` works) or run this with sudo.
   Scout still runs in the foreground with: pnpm start"
  fi
  die "No supported login-service manager here (need launchd on macOS or systemd on Linux).
   Scout still runs with: pnpm start"
fi

case "$ACTION" in
  status)
    printf '  platform  %s\n' "$PLATFORM"
    printf '  service   %s\n' "$("${PLATFORM}_status")"
    printf '  answering %s\n' \
      "$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:3000/ 2>/dev/null || echo 'no')"
    exit 0
    ;;
  uninstall)
    step "Removing the Scout login service"
    "${PLATFORM}_uninstall"
    bold "  Removed. Scout will no longer start on its own."
    exit 0
    ;;
esac

step "Installing Scout as a $PLATFORM login service"
"${PLATFORM}_install"

step "Waiting for it to answer"
for _ in $(seq 1 90); do
  if curl -fsS --max-time 3 http://localhost:3000/ 2>/dev/null | grep -q "SCOUT"; then
    UP=1; break
  fi
  sleep 2
done

if [ "${UP:-0}" != "1" ]; then
  warn "The service is installed but has not answered yet. Its log:"
  tail -25 "${LOG_DIR}/scout.log" 2>/dev/null || true
  die "Not up. Fix what the log shows, then: $0"
fi

printf '\n'
bold "  Scout is installed and running."
printf '\n'
bold "    →  http://localhost:3000"
printf '\n'
printf '  It starts when you log in, restarts if it stops, and survives a reboot.\n'
printf '  You do not need to run pnpm start again.\n\n'
printf '  Status   %s --status\n' "$0"
printf '  Log      %s/scout.log\n' "$LOG_DIR"
printf '  Remove   %s --uninstall\n\n' "$0"
