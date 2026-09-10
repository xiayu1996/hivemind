#!/usr/bin/env bash
# Install the model declarations hivemind adds to pi's built-in catalogue.
#
#   scripts/install-pi-models.sh
#
# pi merges `~/.pi/agent/models.json` into its built-in providers: models are
# upserted by id, so declaring one here adds it without hiding the built-ins.
# The file has to exist on every host, not just the one that first needed the
# model: `fixtures/model-catalogs/` records what pi advertises, and a host
# missing this file would advertise less and fail the drift test.
#
# Rerunning with the file already in place is a no-op. A file this script did
# not write is never overwritten: it may hold a proxy or a local model server
# somebody configured by hand, so the operator is told and the run stops.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO/deploy/pi/models.json"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TARGET="$AGENT_DIR/models.json"

if [ ! -f "$SOURCE" ]; then
  echo "missing $SOURCE" >&2
  exit 1
fi

if [ -f "$TARGET" ]; then
  if cmp -s "$SOURCE" "$TARGET"; then
    echo "pi model declarations already installed at $TARGET"
    exit 0
  fi
  echo "$TARGET exists and differs from $SOURCE." >&2
  echo "Merge the two by hand, then rerun. Diff:" >&2
  diff "$TARGET" "$SOURCE" >&2 || true
  exit 1
fi

mkdir -p "$AGENT_DIR"
cp "$SOURCE" "$TARGET"
echo "pi model declarations installed at $TARGET"
