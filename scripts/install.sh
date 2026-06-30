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

# Optional: dependency-change notifications (design 29). NEVER silent — we only
# append the shell hook with explicit consent: an interactive y/N prompt, or a
# `--with-dep-notify` flag / RBOX_DEP_NOTIFY=1 for non-interactive installs. The
# hook itself runs no install; it just nudges you to re-install when a synced
# lockfile changes. `rbox deps notify off|uninstall` disables/removes it later.
case " $* " in *" --with-dep-notify "*) RBOX_DEP_NOTIFY=1 ;; esac
WANT_DEP_NOTIFY=0
if [ "${RBOX_DEP_NOTIFY:-0}" = "1" ]; then
  WANT_DEP_NOTIFY=1
elif [ -t 0 ]; then
  printf "  Enable dependency-change notifications (a shell-cd hook)? [y/N] "
  read -r REPLY
  case "$REPLY" in [yY]|[yY][eE][sS]) WANT_DEP_NOTIFY=1 ;; esac
fi
if [ "$WANT_DEP_NOTIFY" = "1" ]; then
  if "$DEST/rbox" deps notify install; then
    echo "  ✓ dependency-change notifications enabled (rbox deps notify off to pause)"
  else
    echo "  (couldn't enable dep notifications now — run \`rbox deps notify install\` later)" >&2
  fi
fi
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
