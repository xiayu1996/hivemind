#!/usr/bin/env bash
# Install the pinned SoL-Pi commit into a side-by-side versioned directory.
#
#   scripts/install-sol-pi.sh [ref]
#
# The pin lives in package.json (hivemind.solPiRef); HIVEMIND_SOL_PI_REF or the
# argument override it for a canary host. SoL-Pi publishes no releases, so the
# pin is a commit sha and the checkout is verified to be exactly that commit.
#
# It goes beside pi rather than into this repository's node_modules because it
# imports pi's own packages as peer dependencies and has to resolve them from
# the pi installation that loads it. Refs live at ~/.hivemind/sol-pi/<ref> so
# several coexist and a new pin rolls out per host without touching the running
# one. Rerunning with the same pin is a no-op.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PIN="${1:-${HIVEMIND_SOL_PI_REF:-$(node -p "require('$REPO/package.json').hivemind.solPiRef")}}"
ROOT="${HIVEMIND_HOME:-$HOME/.hivemind}/sol-pi/$PIN"
ENTRY="$ROOT/src/sol-pi/index.ts"

if [ -f "$ENTRY" ] && [ "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" = "$PIN" ]; then
  echo "sol-pi $PIN already installed at $ENTRY"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "fetching sol-pi $PIN"
git -C "$WORK" init -q
git -C "$WORK" remote add origin https://github.com/NVlabs/SoL-Pi.git
git -C "$WORK" fetch -q --depth 1 origin "$PIN"
git -C "$WORK" checkout -q FETCH_HEAD

# A ref that moved is a different extension than the one this repository was
# reviewed against, so the checkout has to be the pinned commit itself.
ACTUAL="$(git -C "$WORK" rev-parse HEAD)"
if [ "$ACTUAL" != "$PIN" ]; then
  echo "ref mismatch: wanted $PIN got $ACTUAL" >&2
  exit 1
fi

if [ ! -f "$WORK/src/sol-pi/index.ts" ]; then
  echo "sol-pi $PIN has no src/sol-pi/index.ts" >&2
  exit 1
fi

rm -rf "$ROOT"
mkdir -p "$(dirname "$ROOT")"
mv "$WORK" "$ROOT"
trap - EXIT

echo "sol-pi $PIN installed at $ENTRY"
