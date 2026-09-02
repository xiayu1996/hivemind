#!/usr/bin/env bash
# Install a pinned pi release into a side-by-side versioned directory.
#
#   scripts/install-pi.sh [version]
#
# Versions live at ~/.hivemind/pi/<version>/pi/pi so several can coexist and the
# orchestrator can roll a new one out per host without touching the running one.
# Checksums are verified against the release SHA256SUMS; a mismatch aborts.

set -euo pipefail

PIN="${1:-${HIVEMIND_PI_VERSION:-0.84.3}}"
ROOT="${HIVEMIND_HOME:-$HOME/.hivemind}/pi/$PIN"
BIN="$ROOT/pi/pi"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  ASSET="pi-darwin-arm64.tar.gz" ;;
  Darwin-x86_64) ASSET="pi-darwin-x64.tar.gz" ;;
  Linux-aarch64) ASSET="pi-linux-arm64.tar.gz" ;;
  Linux-x86_64)  ASSET="pi-linux-x64.tar.gz" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

if [ -x "$BIN" ] && [ "$("$BIN" --version 2>/dev/null)" = "$PIN" ]; then
  echo "pi $PIN already installed at $BIN"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Release assets are public, so a fresh host needs no GitHub login to install
# pi; gh is only the fallback for networks that block the direct download.
RELEASE="https://github.com/earendil-works/pi/releases/download/v$PIN"
echo "downloading pi $PIN ($ASSET)"
if ! (curl -fsSL --retry 3 -o "$WORK/$ASSET" "$RELEASE/$ASSET" \
      && curl -fsSL --retry 3 -o "$WORK/SHA256SUMS" "$RELEASE/SHA256SUMS"); then
  echo "direct download failed; trying gh"
  gh release download "v$PIN" --repo earendil-works/pi \
    --pattern "$ASSET" --pattern SHA256SUMS --dir "$WORK" --clobber
fi

echo "verifying checksum"
EXPECTED="$(grep " $ASSET\$" "$WORK/SHA256SUMS" | awk '{print $1}')"
if [ -z "$EXPECTED" ]; then
  echo "no checksum entry for $ASSET" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$WORK/$ASSET" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$WORK/$ASSET" | awk '{print $1}')"
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "checksum mismatch: expected $EXPECTED got $ACTUAL" >&2
  exit 1
fi

rm -rf "$ROOT"
mkdir -p "$ROOT"
tar -xzf "$WORK/$ASSET" -C "$ROOT"

INSTALLED="$("$BIN" --version)"
if [ "$INSTALLED" != "$PIN" ]; then
  echo "version mismatch after install: wanted $PIN got $INSTALLED" >&2
  exit 1
fi
echo "pi $INSTALLED installed at $BIN"
