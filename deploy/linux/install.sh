#!/usr/bin/env bash
# Prepare one Linux host to run hivemind end to end: the orchestrator that
# executes Epics and Stories, and the requirement loop that runs the product
# manager. Idempotent; rerun after a pull.
#
#   deploy/linux/install.sh --repository-path /srv/repo [--repository-id repo] [--repository-slug owner/name]
#
# Node 26+ is a prerequisite (nvm or fnm both work). Credentials are never
# handled here: the script leaves a template at ~/.hivemind/secrets.env and
# stops until a person fills it in.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HIVEMIND_HOME="${HIVEMIND_HOME:-$HOME/.hivemind}"
REPOSITORY_PATH=""
REPOSITORY_ID=""
REPOSITORY_SLUG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repository-path) REPOSITORY_PATH="$2"; shift 2 ;;
    --repository-id) REPOSITORY_ID="$2"; shift 2 ;;
    --repository-slug) REPOSITORY_SLUG="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ -z "$REPOSITORY_PATH" ]; then
  echo "--repository-path is required: the checkout the agents will work in" >&2
  exit 1
fi
REPOSITORY_PATH="$(cd "$REPOSITORY_PATH" && pwd)"
if [ -z "$REPOSITORY_SLUG" ]; then
  REMOTE="$(git -C "$REPOSITORY_PATH" remote get-url origin)"
  REPOSITORY_SLUG="$(echo "${REMOTE%.git}" | sed -E 's#.*[/:]([^/:]+/[^/]+)$#\1#')"
fi
REPOSITORY_ID="${REPOSITORY_ID:-${REPOSITORY_SLUG##*/}}"

step() { echo; echo "== $*"; }

step "Node.js"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 26 ]; then
  echo "Node 26 or newer is required; found $(node --version)" >&2
  exit 1
fi
echo "node $(node --version) at $(command -v node)"

step "Dependencies"
(cd "$REPO" && npm ci --no-audit --no-fund)

step "pi"
"$REPO/scripts/install-pi.sh"

step "Headless Chromium for the browser lane"
# The alpha playwright the CLI pins needs its own headless shell build; system
# libraries need root, so the with-deps pass is retried with sudo when needed.
if ! (cd "$REPO" && npx playwright-cli install-browser chromium --only-shell --with-deps); then
  echo "installing browser system dependencies needs root; retrying with sudo"
  (cd "$REPO" && sudo npx playwright install-deps chromium && npx playwright-cli install-browser chromium --only-shell)
fi

step "Review-request CLI"
if command -v gh >/dev/null 2>&1; then
  echo "gh $(gh --version | head -1)"
elif command -v glab >/dev/null 2>&1; then
  echo "glab $(glab --version | head -1)"
else
  echo "install gh (GitHub) or glab (GitLab) and sign in before starting the services" >&2
fi

step "Home directory"
mkdir -p "$HIVEMIND_HOME"
chmod 700 "$HIVEMIND_HOME"
SECRETS="$HIVEMIND_HOME/secrets.env"
if [ ! -f "$SECRETS" ]; then
  cat >"$SECRETS" <<'EOF'
# hivemind credentials. chmod 600. Never commit, log or paste this file.
NOTION_TOKEN=
HIVEMIND_NOTION_PARENT_PAGE_ID=
# Filled in by scripts/notion-bootstrap.ts:
# HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID=
# HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID=
# HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID=
# NOTION_BOT_USER_ID=
# One out-of-band alert channel:
FEISHU_WEBHOOK_URL=
# or SMTP_HOST= SMTP_PORT= SMTP_USER= SMTP_PASSWORD= SMTP_FROM= SMTP_TO=
EOF
  echo "wrote a template to $SECRETS; fill it in before the next step"
fi
chmod 600 "$SECRETS"
mkdir -p "$REPO/data"

step "Service environment"
# systemd units do not load a login shell, so the node the operator installed
# has to be named explicitly.
NODE_BIN_DIR="$(dirname "$(command -v node)")"
cat >"$HIVEMIND_HOME/service.env" <<EOF
PATH=$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin
HIVEMIND_REPO=$REPO
HIVEMIND_REPOSITORY_PATH=$REPOSITORY_PATH
HIVEMIND_REPOSITORY_ID=$REPOSITORY_ID
HIVEMIND_REPOSITORY_SLUG=$REPOSITORY_SLUG
HIVEMIND_DB_URL=file:$REPO/data/hivemind.db
EOF
chmod 600 "$HIVEMIND_HOME/service.env"
echo "repository $REPOSITORY_SLUG (id $REPOSITORY_ID) at $REPOSITORY_PATH"

step "systemd user units"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
for unit in hivemind-orchestrator hivemind-requirements; do
  sed "s#@REPO@#$REPO#g" "$REPO/deploy/linux/systemd/$unit.service" >"$UNIT_DIR/$unit.service"
done
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
  echo "units installed; they start after the checks below pass"
fi

cat <<EOF

Next, in this order:
  1. Fill in $SECRETS (NOTION_TOKEN, the parent page id, one alert channel).
  2. $REPO/scripts/pi-login.sh            # provider login; device-code flow on a headless host
  3. gh auth login                          # or glab auth login
  4. (cd $REPO && npx tsx scripts/notion-bootstrap.ts)   # once per board; stores the data source ids
  5. (cd $REPO && npm run preflight -- --repository-path $REPOSITORY_PATH)
  6. loginctl enable-linger \$USER
     systemctl --user enable --now hivemind-orchestrator hivemind-requirements
     journalctl --user -fu hivemind-orchestrator
EOF
