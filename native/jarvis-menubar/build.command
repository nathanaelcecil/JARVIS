#!/bin/bash
# Build JARVIS Menu Bar into a real .app bundle.
#
# A bundle (not a bare binary) is what makes the microphone, speech-recognition
# and accessibility grants stick: macOS keys those permissions to the bundle
# identifier and the Info.plist usage strings.
set -euo pipefail

cd "$(dirname "$0")"

APP="bin/JARVISMenuBar.app"
BIN="$APP/Contents/MacOS/JARVISMenuBar"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Info.plist "$APP/Contents/Info.plist"

echo "Building JARVIS Menu Bar → $APP"
swiftc -O \
    -target "$(uname -m)-apple-macos13.0" \
    -framework Cocoa \
    -framework AVFoundation \
    -framework Speech \
    -framework Carbon \
    -o "$BIN" \
    main.swift

# Ad-hoc signing alone yields a cdhash-only designated requirement, so every
# rebuild would invalidate the Accessibility grant. Pin the requirement to the
# bundle identifier instead: the grant then survives rebuilds.
codesign --force --deep --sign - \
    --identifier local.jarvis.menubar \
    --requirements '=designated => identifier "local.jarvis.menubar"' \
    "$APP" >/dev/null 2>&1 || \
    echo "note: ad-hoc codesign skipped"

echo "Done. Launch with: open $APP"
echo "Permissions are requested on first use (Microphone, Speech Recognition)."
echo ""
echo "Accessibility: if the grant is ever lost, remove and re-add \"JARVIS Menu"
echo "Bar\" in System Settings → Privacy & Security → Accessibility once; the"
echo "signature now keys to the bundle id, so later rebuilds keep the grant."
