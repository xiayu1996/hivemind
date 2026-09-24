#!/usr/bin/env bash
# Install the pinned impeccable detect engine into a side-by-side directory.
#
#   scripts/install-design-lint.sh [engine-version]
#
# The pin lives in package.json (hivemind.impeccableEngineVersion, without the
# `engine-v` prefix); the argument overrides it for a canary host. Builds live
# at ~/.hivemind/impeccable/<version>/impeccable so several coexist.
#
# The npm package is deliberately not used: it is a shim whose real binary is an
# optional dependency or a first-run download into ~/.impeccable/bin, and a
# first-run download is a network call nobody is watching at three in the
# morning. The release asset is fetched directly and checked against its own
# .sha256 file. Rerunning with the same pin is a no-op.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PIN="${1:-$(node -p "require('$REPO/package.json').hivemind.impeccableEngineVersion")}"
REPORTED="$(node -p "require('$REPO/package.json').hivemind.impeccableReportedVersion")"
ROOT="${HIVEMIND_HOME:-$HOME/.hivemind}/impeccable/$PIN"
BIN="$ROOT/impeccable"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  ASSET="impeccable-darwin-arm64" ;;
  Darwin-x86_64) ASSET="impeccable-darwin-x64" ;;
  Linux-aarch64) ASSET="impeccable-linux-arm64" ;;
  Linux-x86_64)  ASSET="impeccable-linux-x64" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

# The binary shares its version line with the skill package, so it reports
# something unrelated to the engine tag it was released under; both numbers are
# pinned and this compares the one the binary can actually answer with.
if [ -x "$BIN" ] && [ "$("$BIN" --version 2>/dev/null)" = "$REPORTED" ]; then
  echo "impeccable engine-v$PIN already installed at $BIN"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

RELEASE="https://github.com/pbakaus/impeccable/releases/download/engine-v$PIN"
echo "downloading impeccable engine-v$PIN ($ASSET)"
if ! (curl -fsSL --retry 3 -o "$WORK/$ASSET" "$RELEASE/$ASSET" \
      && curl -fsSL --retry 3 -o "$WORK/$ASSET.sha256" "$RELEASE/$ASSET.sha256"); then
  echo "direct download failed; trying gh"
  gh release download "engine-v$PIN" --repo pbakaus/impeccable \
    --pattern "$ASSET" --pattern "$ASSET.sha256" --dir "$WORK" --clobber
fi

echo "verifying checksum"
EXPECTED="$(awk '{print $1}' "$WORK/$ASSET.sha256")"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$WORK/$ASSET" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$WORK/$ASSET" | awk '{print $1}')"
fi
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "checksum mismatch: expected ${EXPECTED:-<none>} got $ACTUAL" >&2
  exit 1
fi

rm -rf "$ROOT"
mkdir -p "$ROOT"
install -m 0755 "$WORK/$ASSET" "$BIN"

INSTALLED="$("$BIN" --version)"
if [ "$INSTALLED" != "$REPORTED" ]; then
  echo "version mismatch after install: wanted $REPORTED got $INSTALLED" >&2
  exit 1
fi
echo "impeccable $INSTALLED (engine-v$PIN) installed at $BIN"
