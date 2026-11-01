#!/bin/bash
# Build the JARVIS control helper (Hands v2) — the only binary that can act.
#
#   ./native/jarvis-hands-control/build.command
#
# Output: native/jarvis-hands-control/bin/jarvis-hands-control (git-ignored).
#
# This is a SEPARATE binary from native/jarvis-hands (observation) on purpose:
# macOS grants Accessibility per binary, so the user can revoke control without
# losing the ability to read windows, and granting observation never silently
# grants the ability to click or type.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/bin"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$OUT"
echo "Building jarvis-hands-control → $OUT/jarvis-hands-control"
swiftc -O -swift-version 5 \
  -o "$OUT/jarvis-hands-control" \
  "$DIR/main.swift" \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework AppKit \
  -framework Foundation
echo "Done. Check permissions with: $OUT/jarvis-hands-control permissions"
