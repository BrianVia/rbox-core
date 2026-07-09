#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/RboxBar.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

cd "$ROOT"
swift build -c release
BIN_PATH="$(swift build -c release --show-bin-path)"

rm -rf "$APP"
mkdir -p "$MACOS" "$RESOURCES"

cp "$BIN_PATH/RboxBar" "$MACOS/RboxBar"
cp "$ROOT/Resources/AppIcon.icns" "$RESOURCES/AppIcon.icns"

BUNDLE_PATH="$(find "$BIN_PATH" -maxdepth 1 -name 'RboxBar_RboxBar.bundle' -type d -print -quit)"
if [[ -z "$BUNDLE_PATH" ]]; then
  echo "Missing SwiftPM resource bundle: $BIN_PATH/RboxBar_RboxBar.bundle" >&2
  exit 1
fi
cp -R "$BUNDLE_PATH" "$RESOURCES/"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>rbox Bar</string>
  <key>CFBundleIdentifier</key>
  <string>to.rbox.RboxBar</string>
  <key>CFBundleExecutable</key>
  <string>RboxBar</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
</dict>
</plist>
PLIST

chmod +x "$MACOS/RboxBar"
codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true

echo "Created $APP"
echo "Run with: open \"$APP\""
