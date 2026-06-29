#!/bin/sh
# rbox installer — curl -fsSL https://rbox.to/install.sh | sh
# Downloads the prebuilt rbox CLI for your platform and installs it to ~/.rbox/bin.
set -e

BASE="${RBOX_DOWNLOAD_BASE:-https://api.rbox.to}"
DEST="$HOME/.rbox/bin"
[ -n "$RBOX_INSTALL_DIR" ] && DEST="$RBOX_INSTALL_DIR"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "rbox: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
case "$OS" in
  darwin|linux) ;;
  *) echo "rbox: unsupported OS: $OS (only macOS and Linux are supported)" >&2; exit 1 ;;
esac

BIN="rbox-$OS-$ARCH"
URL="$BASE/bin/$BIN"

echo "Installing rbox ($OS/$ARCH) -> $DEST/rbox"
mkdir -p "$DEST"

# Download to a temp file, then atomically move into place — a failed/partial
# download never clobbers an existing working binary (design 14 U8). HTTPS only
# (incl. redirects). The temp is cleaned up on any exit.
TMP="$DEST/.rbox.install.$$"
trap 'rm -f "$TMP"' EXIT INT TERM
if ! curl -fSL --proto '=https' --proto-redir '=https' "$URL" -o "$TMP"; then
  echo "rbox: download failed from $URL" >&2
  exit 1
fi
chmod +x "$TMP"
mv -f "$TMP" "$DEST/rbox"
trap - EXIT INT TERM

echo ""
echo "  ✓ rbox installed to $DEST/rbox"
echo "  (verify integrity via the signed manifest: $BASE/version — rbox upgrade checks it automatically)"
echo ""
case ":$PATH:" in
  *":$DEST:"*)
    echo "  Run: rbox" ;;
  *)
    echo "  Add it to your PATH (then restart your shell):"
    echo "      export PATH=\"$DEST:\$PATH\""
    echo ""
    echo "  Then run: rbox" ;;
esac
