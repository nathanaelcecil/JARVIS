#!/bin/bash
# Build every JARVIS native helper.
#
#   ./native/build-all.command
#
# Two binaries, two macOS permissions:
#   native/jarvis-hands/bin/jarvis-hands                  observation only
#   native/jarvis-hands-control/bin/jarvis-hands-control  acting (confirm tier)
#
# Build output is git-ignored. Nothing here grants a permission — that is done
# once by hand in System Settings → Privacy & Security.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for helper in jarvis-hands jarvis-hands-control; do
  echo "── $helper ──"
  "$DIR/$helper/build.command"
done

echo
echo "Permission status:"
"$DIR/jarvis-hands/bin/jarvis-hands" permissions
"$DIR/jarvis-hands-control/bin/jarvis-hands-control" permissions
