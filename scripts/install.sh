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

# Intel Macs are not a release target — Apple Silicon only on macOS. Bail with a friendly
# message rather than downloading a nonexistent/broken rbox-darwin-x64 binary.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  echo "rbox requires an Apple Silicon Mac (M1 or newer). Intel Macs are not supported." >&2
  echo "(Linux x64 and arm64 are also supported.)" >&2
  exit 1
fi

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

# Optional: dependency-change notifications (design 29) — commented out
# (design 50): `rbox deps notify install` runs through the `deps` CLI group,
# which is currently disabled (src/cli/index.ts). Offering this now would
# either silently fail or install a hook that always fails. Re-enable together
# with `deps` itself.
#
# case " $* " in *" --with-dep-notify "*) RBOX_DEP_NOTIFY=1 ;; esac
# WANT_DEP_NOTIFY=0
# if [ "${RBOX_DEP_NOTIFY:-0}" = "1" ]; then
#   WANT_DEP_NOTIFY=1
# elif [ -t 0 ]; then
#   printf "  Enable dependency-change notifications (a shell-cd hook)? [y/N] "
#   read -r REPLY
#   case "$REPLY" in [yY]|[yY][eE][sS]) WANT_DEP_NOTIFY=1 ;; esac
# fi
# if [ "$WANT_DEP_NOTIFY" = "1" ]; then
#   if "$DEST/rbox" deps notify install; then
#     echo "  ✓ dependency-change notifications enabled (rbox deps notify off to pause)"
#   else
#     echo "  (couldn't enable dep notifications now — run \`rbox deps notify install\` later)" >&2
#   fi
# fi
echo ""

# Persist PATH so NEW shells find rbox — the #1 "installed but not found" gotcha.
# We append a clearly-marked, idempotent block to your login shell's rc file; delete
# the block to undo. Opt out with --no-modify-path (or RBOX_NO_MODIFY_PATH=1), in
# which case we just print the export line as before.
case " $* " in *" --no-modify-path "*) RBOX_NO_MODIFY_PATH=1 ;; esac

case ":$PATH:" in
  *":$DEST:"*)
    echo "  ✓ $DEST is already on your PATH"
    echo "  Run: rbox" ;;
  *)
    RC=""
    case "$(basename "${SHELL:-sh}")" in
      zsh)  RC="$HOME/.zshrc" ;;
      bash) [ -f "$HOME/.bashrc" ] && RC="$HOME/.bashrc" || RC="$HOME/.bash_profile" ;;
      *)    RC="$HOME/.profile" ;;
    esac
    if [ "${RBOX_NO_MODIFY_PATH:-0}" = "1" ]; then
      echo "  Add it to your PATH (then restart your shell):"
      echo "      export PATH=\"$DEST:\$PATH\""
      echo "  Then run: rbox"
    elif [ -f "$RC" ] && grep -q '# >>> rbox PATH >>>' "$RC" 2>/dev/null; then
      echo "  ✓ PATH already configured in $RC — open a new terminal, then run: rbox"
    elif {
           printf '\n# >>> rbox PATH >>>\n'
           printf 'export PATH="%s:$PATH"\n' "$DEST"
           printf '# <<< rbox PATH <<<\n'
         } >> "$RC" 2>/dev/null; then
      echo "  ✓ added $DEST to your PATH in $RC"
      echo "  Open a new terminal (or run: source \"$RC\"), then run: rbox"
    else
      echo "  Couldn't update $RC automatically — add it to your PATH manually:"
      echo "      export PATH=\"$DEST:\$PATH\""
      echo "  Then run: rbox"
    fi ;;
esac
