#!/usr/bin/env bash
# Interactive login for a pi provider, using the pinned pi build.
#
#   scripts/pi-login.sh [provider]        # default: openai-codex
#
# Login only exists inside pi's interactive TUI (`/login`), so this must run in a
# real terminal — it cannot be scripted or run from a service unit. On a headless
# host, ssh in and choose "Device code login (headless)" instead of browser login.

set -euo pipefail

PROVIDER="${1:-openai-codex}"
PIN="${HIVEMIND_PI_VERSION:-0.84.3}"
BIN="${HIVEMIND_HOME:-$HOME/.hivemind}/pi/$PIN/pi/pi"

if [ ! -x "$BIN" ]; then
  echo "pi $PIN not installed. Run scripts/install-pi.sh first." >&2
  exit 1
fi
if [ ! -t 0 ]; then
  echo "This needs an interactive terminal (pi's /login is a TUI command)." >&2
  exit 1
fi

cat <<EOF
About to open pi $PIN and run: /login $PROVIDER

  1. Pick the provider if prompted.
  2. Choose a login method:
       Browser login (default)     - this machine has a browser; it opens and returns automatically
       Device code login (headless) - shows a code to enter on another device; expires in 15 minutes
  3. Authorize in the browser.
  4. Press Ctrl+C (or /exit) to leave pi once it reports success.

Credentials are written to ~/.pi/agent/auth.json, separate from ~/.codex/auth.json.
Logging in here does NOT affect an existing codex CLI login on the same machine.

EOF
read -r -p "Press Enter to continue..." _

exec "$BIN" "/login $PROVIDER"
