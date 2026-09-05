#!/usr/bin/env bash
# The one entry point that takes a Linux host from a fresh checkout to two
# running services: the orchestrator (Epics and Stories) and the requirement
# loop (the product manager). Supports Ubuntu/Debian, Arch-based distributions
# such as Omarchy, and Ubuntu inside WSL2 on Windows.
#
#   deploy/linux/install.sh --repository-path /srv/repo [--repository-id repo] [--repository-slug owner/name]
#
# Idempotent: every stage checks before it acts, so rerun it after a pull, after
# filling in credentials, or after any interrupted attempt. Stages a person has
# to do by hand (credentials, provider login, review-CLI login) stop the script
# with exactly one instruction; rerunning continues from there. Credentials are
# never read, printed or passed on a command line here.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HIVEMIND_HOME="${HIVEMIND_HOME:-$HOME/.hivemind}"
SECRETS="$HIVEMIND_HOME/secrets.env"
PROVIDER="${HIVEMIND_PI_PROVIDER:-openai-codex}"
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
case "$REPOSITORY_SLUG" in
  */*) ;;
  *)
    echo "cannot read an owner/name slug from the origin remote; pass --repository-slug owner/name" >&2
    echo "(cards on the board name the repository by that slug, and only matching cards are dispatched here)" >&2
    exit 1 ;;
esac
REPOSITORY_ID="${REPOSITORY_ID:-${REPOSITORY_SLUG##*/}}"

step() { echo; echo "== $*"; }
# A stage only a person can finish: say the one thing to do, then stop. Exit 2
# distinguishes "waiting on you" from a real failure.
waiting() { echo; echo "WAITING ON YOU: $*"; echo "Then rerun this script; it continues from here."; exit 2; }
# Reads one key from secrets.env without echoing its value anywhere.
secret_set() { grep -Eq "^[[:space:]]*$1=[^[:space:]]" "$SECRETS" 2>/dev/null; }

step "Host"
. /etc/os-release
FAMILY=""
case " $ID ${ID_LIKE:-} " in
  *" ubuntu "*|*" debian "*) FAMILY="debian" ;;
  *" arch "*) FAMILY="arch" ;;
esac
if [ -z "$FAMILY" ]; then
  echo "unsupported distribution: $PRETTY_NAME (Ubuntu/Debian and Arch-based distributions are supported)" >&2
  exit 1
fi
WSL=""
if grep -qi microsoft /proc/version 2>/dev/null; then WSL="yes"; fi
echo "$PRETTY_NAME ($FAMILY)${WSL:+, inside WSL2}"

if [ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]; then
  if [ -n "$WSL" ]; then
    cat >&2 <<'EOT'
systemd is not running in this WSL distribution. Enable it once:
  printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf
then from Windows: wsl --shutdown, reopen the distribution, and rerun this script.
EOT
  else
    echo "systemd is not PID 1; the service units cannot be installed on this host" >&2
  fi
  exit 1
fi

step "Node.js"
if ! command -v node >/dev/null 2>&1; then
  case "$FAMILY" in
    debian) echo "install Node 26+ first (nvm or fnm), then rerun" >&2 ;;
    arch)   echo "install Node 26+ first: sudo pacman -S --needed nodejs npm" >&2 ;;
  esac
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 26 ]; then
  echo "Node 26 or newer is required; found $(node --version)" >&2
  exit 1
fi
echo "node $(node --version) at $(command -v node)"

step "Dependencies"
# npm ci wipes node_modules; skip it when the lockfile has not changed since the last install.
if [ -f "$REPO/node_modules/.package-lock.json" ] && [ ! "$REPO/package-lock.json" -nt "$REPO/node_modules/.package-lock.json" ]; then
  echo "node_modules matches package-lock.json"
else
  (cd "$REPO" && npm ci --no-audit --no-fund)
fi

step "System packages for headless Chromium"
# Playwright's own install-deps only knows apt. On Arch the shared libraries the
# headless shell links against are installed by name; --needed keeps it idempotent.
case "$FAMILY" in
  debian)
    if [ "$(uname -m)" = "aarch64" ] && ! ldconfig -p | grep -q libatomic.so.1; then
      echo "arm64 Node needs libatomic1"
      sudo apt-get install -y libatomic1
    fi
    if ! (cd "$REPO" && npx playwright-cli install-browser --list 2>/dev/null | grep -q chromium_headless_shell); then
      echo "installing Chromium system libraries (needs sudo)"
      # root does not see an nvm/fnm node, so the operator's PATH is passed through.
      (cd "$REPO" && sudo env "PATH=$PATH" npx playwright install-deps chromium)
    else
      echo "already present"
    fi ;;
  arch)
    PKGS="nss nspr at-spi2-core cups libdrm libxkbcommon libxcomposite libxdamage libxrandr mesa pango cairo alsa-lib ttf-liberation"
    MISSING=""
    for pkg in $PKGS; do pacman -Qq "$pkg" >/dev/null 2>&1 || MISSING="$MISSING $pkg"; done
    if [ -n "$MISSING" ]; then
      echo "installing:$MISSING (needs sudo)"
      # shellcheck disable=SC2086 # MISSING is a deliberate word list
      sudo pacman -S --needed --noconfirm $MISSING
    else
      echo "already present"
    fi ;;
esac

step "Kernel: unprivileged user namespaces for the Chromium sandbox"
# Ubuntu 23.10+ restricts them through AppArmor and Chromium then fails with
# "No usable sandbox!". The key does not exist in the WSL kernel or on Arch.
USERNS_KEY=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [ -f "$USERNS_KEY" ] && [ "$(cat "$USERNS_KEY")" = "1" ]; then
  echo "AppArmor restricts unprivileged user namespaces; lifting it (needs sudo)"
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null
  echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-hivemind-chromium.conf >/dev/null
else
  echo "ok"
fi

step "pi"
"$REPO/scripts/install-pi.sh"
PI_VERSION="$(node -p "require('$REPO/package.json').hivemind.piVersion")"
PI_BIN="${PI_BIN:-$HIVEMIND_HOME/pi/${HIVEMIND_PI_VERSION:-$PI_VERSION}/pi/pi}"

step "Headless Chromium"
if (cd "$REPO" && npx playwright-cli install-browser --list 2>/dev/null | grep -q chromium_headless_shell); then
  echo "already installed"
else
  (cd "$REPO" && npx playwright-cli install-browser chromium --only-shell)
fi

step "Review-request CLI"
REVIEW_CLI=""
if command -v gh >/dev/null 2>&1; then REVIEW_CLI="gh"; elif command -v glab >/dev/null 2>&1; then REVIEW_CLI="glab"; fi
if [ -z "$REVIEW_CLI" ]; then
  case "$FAMILY" in
    debian) waiting "install the review CLI: sudo apt-get install -y gh   (GitHub)  or  glab (GitLab)" ;;
    arch)   waiting "install the review CLI: sudo pacman -S --needed github-cli   (GitHub)  or  glab (GitLab)" ;;
  esac
fi
echo "$REVIEW_CLI $($REVIEW_CLI --version | head -1)"

step "Home directory"
mkdir -p "$HIVEMIND_HOME" "$REPO/data"
chmod 700 "$HIVEMIND_HOME"
if [ ! -f "$SECRETS" ]; then
  cat >"$SECRETS" <<'EOT'
# hivemind credentials. chmod 600. Never commit, log or paste this file.
# Notion internal connection token and the page shared with it (see docs/runbooks/linux-single-node.md).
NOTION_TOKEN=
HIVEMIND_NOTION_PARENT_PAGE_ID=
# Written by the installer when it bootstraps the board:
# HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID=
# HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID=
# HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID=
# NOTION_BOT_USER_ID=
# One out-of-band alert channel; without it nobody learns about a blocking question.
FEISHU_WEBHOOK_URL=
# or SMTP_HOST= SMTP_PORT= SMTP_SECURE= SMTP_USER= SMTP_PASSWORD= SMTP_FROM= SMTP_TO=
EOT
  echo "wrote a template to $SECRETS"
fi
chmod 600 "$SECRETS"

step "Service environment"
# systemd units do not load a login shell, so the node the operator installed
# has to be named explicitly.
NODE_BIN_DIR="$(dirname "$(command -v node)")"
cat >"$HIVEMIND_HOME/service.env" <<EOT
PATH=$NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin
HIVEMIND_REPO=$REPO
HIVEMIND_REPOSITORY_PATH=$REPOSITORY_PATH
HIVEMIND_REPOSITORY_ID=$REPOSITORY_ID
HIVEMIND_REPOSITORY_SLUG=$REPOSITORY_SLUG
HIVEMIND_DB_URL=file:$REPO/data/hivemind.db
EOT
chmod 600 "$HIVEMIND_HOME/service.env"
echo "repository $REPOSITORY_SLUG (id $REPOSITORY_ID) at $REPOSITORY_PATH"

step "systemd user units"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
for unit in hivemind-orchestrator hivemind-requirements; do
  sed "s#@REPO@#$REPO#g" "$REPO/deploy/linux/systemd/$unit.service" >"$UNIT_DIR/$unit.service"
done
systemctl --user daemon-reload
echo "installed"

step "Credentials"
if ! secret_set NOTION_TOKEN || ! secret_set HIVEMIND_NOTION_PARENT_PAGE_ID; then
  waiting "fill NOTION_TOKEN and HIVEMIND_NOTION_PARENT_PAGE_ID in $SECRETS"
fi
if ! secret_set FEISHU_WEBHOOK_URL && ! secret_set SMTP_HOST; then
  waiting "configure one alert channel in $SECRETS (FEISHU_WEBHOOK_URL, or the SMTP_* block)"
fi
echo "secrets file has the required keys"

step "pi provider login ($PROVIDER)"
# `pi auth check` exits 0 even when not ready, so the JSON status is what counts.
pi_ready() { "$PI_BIN" auth check --provider "$PROVIDER" --json --no-refresh 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"ready"'; }
if ! pi_ready; then
  if [ -t 0 ]; then
    "$REPO/scripts/pi-login.sh" "$PROVIDER"
  fi
  pi_ready || waiting "log in to $PROVIDER from an interactive terminal: $REPO/scripts/pi-login.sh $PROVIDER"
fi
echo "ready"

step "$REVIEW_CLI login"
if ! "$REVIEW_CLI" auth status >/dev/null 2>&1; then
  if [ -t 0 ]; then
    "$REVIEW_CLI" auth login
  fi
  "$REVIEW_CLI" auth status >/dev/null 2>&1 || waiting "sign in: $REVIEW_CLI auth login"
fi
echo "signed in"

step "Notion board"
# Bootstrap is not idempotent on the Notion side (it would create a second board),
# so it only runs while the ids it produces are absent from the secrets file.
if secret_set HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID && secret_set HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID \
   && secret_set HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID && secret_set NOTION_BOT_USER_ID; then
  echo "already bootstrapped"
elif secret_set HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID; then
  (cd "$REPO" && npx tsx scripts/notion-bootstrap.ts --requirements-only)
else
  (cd "$REPO" && npx tsx scripts/notion-bootstrap.ts)
  echo "board views are created by hand once: docs/runbooks/notion-bootstrap.md"
fi

step "Preflight"
if ! (cd "$REPO" && npm run --silent preflight -- --repository-path "$REPOSITORY_PATH"); then
  echo
  echo "fix the FAIL lines above and rerun this script" >&2
  exit 1
fi

step "Services"
loginctl enable-linger "$USER" 2>/dev/null || echo "loginctl enable-linger failed; the services stop when you log out"
systemctl --user enable hivemind-orchestrator hivemind-requirements >/dev/null
systemctl --user restart hivemind-orchestrator hivemind-requirements
systemctl --user --no-pager --lines=0 status hivemind-orchestrator hivemind-requirements || true
cat <<EOT

Running. Follow along with:
  journalctl --user -fu hivemind-orchestrator
  journalctl --user -fu hivemind-requirements
After a pull or a change to $SECRETS, rerun this script; it restarts what changed.
EOT
