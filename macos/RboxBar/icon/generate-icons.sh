#!/usr/bin/env bash
# Render the rbox icon SVGs into the macOS assets the app bundle needs:
#   1. AppIcon.icns          — the dock/Finder/notification icon (all @1x/@2x sizes)
#   2. RGlyph.imageset       — a vector, template-rendered menu-bar glyph (PDF)
#
# Requires rsvg-convert (brew install librsvg) + iconutil (ships with macOS).
# Re-run whenever rbox-icon.svg / rbox-glyph.svg change; outputs are committed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
icon_svg="$here/rbox-icon.svg"
glyph_svg="$here/rbox-glyph.svg"
assets="$root/Resources/Assets.xcassets"

command -v rsvg-convert >/dev/null || { echo "error: rsvg-convert not found (brew install librsvg)"; exit 1; }

# ── 1. App icon → .iconset → .icns ──────────────────────────────────────────
iconset="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$iconset"
render() { rsvg-convert -w "$1" -h "$1" "$icon_svg" -o "$2"; }
render 16   "$iconset/icon_16x16.png"
render 32   "$iconset/icon_16x16@2x.png"
render 32   "$iconset/icon_32x32.png"
render 64   "$iconset/icon_32x32@2x.png"
render 128  "$iconset/icon_128x128.png"
render 256  "$iconset/icon_128x128@2x.png"
render 256  "$iconset/icon_256x256.png"
render 512  "$iconset/icon_256x256@2x.png"
render 512  "$iconset/icon_512x512.png"
render 1024 "$iconset/icon_512x512@2x.png"
mkdir -p "$root/Resources"
iconutil -c icns "$iconset" -o "$root/Resources/AppIcon.icns"
echo "wrote Resources/AppIcon.icns"

# ── 2. Menu-bar glyph → template PDF imageset ───────────────────────────────
glyph_set="$assets/RGlyph.imageset"
mkdir -p "$glyph_set"
rsvg-convert -f pdf "$glyph_svg" -o "$glyph_set/rbox-glyph.pdf"
cat > "$glyph_set/Contents.json" <<'JSON'
{
  "images" : [
    { "filename" : "rbox-glyph.pdf", "idiom" : "universal" }
  ],
  "info" : { "author" : "xcode", "version" : 1 },
  "properties" : {
    "preserves-vector-representation" : true,
    "template-rendering-intent" : "template"
  }
}
JSON
echo "wrote Resources/Assets.xcassets/RGlyph.imageset (template PDF)"

# ── 3. A large PNG preview (handy for eyeballing the design) ─────────────────
rsvg-convert -w 512 -h 512 "$icon_svg" -o "$here/preview-512.png"
echo "wrote icon/preview-512.png"
