#!/bin/bash
# Build the read-only JARVIS "hands" observation helper.
#
#   ./native/jarvis-hands/build.command
#
# Output: native/jarvis-hands/bin/jarvis-hands (git-ignored).
# The helper only observes — it cannot click, type, press keys or open apps.
# Control lives in a separate binary: native/jarvis-hands-control/.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/bin"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$OUT"
echo "Building jarvis-hands → $OUT/jarvis-hands"
swiftc -O -swift-version 5 \
  -o "$OUT/jarvis-hands" \
  "$DIR/main.swift" \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework AppKit \
  -framework Vision \
  -framework Foundation
echo "Done. Check permissions with: $OUT/jarvis-hands permissions"
