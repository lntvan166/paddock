#!/bin/sh
# paddock installer. Downloads the release binary for this platform, verifies
# its checksum, and installs it to ~/.local/bin.
#
# Read before running:
#   curl -fsSL https://lntvan166.github.io/paddock/install.sh | less
#
# No privilege escalation of any kind: ~/.local/bin is user-writable, so
# nothing here needs it — a one-liner that asks for root to install a
# dashboard is a habit worth not teaching.
set -eu

REPO="lntvan166/paddock"
BIN_DIR="${PADDOCK_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/paddock"

# Overridable so the platform table can be tested without four machines.
UNAME_S="${PADDOCK_UNAME_S:-$(uname -s)}"
UNAME_M="${PADDOCK_UNAME_M:-$(uname -m)}"

asset_name() {
  case "$UNAME_S" in
    Linux)  os=linux ;;
    Darwin) os=macos ;;
    *) echo "paddock: unsupported operating system: $UNAME_S" >&2
       echo "supported: Linux, Darwin (macOS)" >&2; exit 1 ;;
  esac
  case "$UNAME_M" in
    x86_64|amd64)  arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo "paddock: unsupported architecture: $UNAME_M" >&2
       echo "supported: x86_64, aarch64" >&2; exit 1 ;;
  esac
  echo "paddock-$os-$arch"
}

ASSET="$(asset_name)"

if [ "${1:-}" = "--print-asset" ]; then echo "$ASSET"; exit 0; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BASE="https://github.com/$REPO/releases/latest/download"
echo "paddock: downloading $ASSET"
curl -fsSL "$BASE/$ASSET" -o "$TMP/paddock"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"

echo "paddock: verifying checksum"
EXPECTED="$(grep " $ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}')"
if [ -z "$EXPECTED" ]; then
  echo "paddock: $ASSET is not listed in SHA256SUMS — refusing to install" >&2
  exit 1
fi
if command -v sha256sum >/dev/null; then
  ACTUAL="$(sha256sum "$TMP/paddock" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$TMP/paddock" | awk '{print $1}')"
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "paddock: CHECKSUM MISMATCH — refusing to install" >&2
  echo "  expected $EXPECTED" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
chmod +x "$TMP/paddock"
mv "$TMP/paddock" "$BIN"
echo "paddock: installed to $BIN"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""
     echo "paddock: $BIN_DIR is not on your PATH. Add this to your shell profile:"
     echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo "paddock: run 'paddock' to start the dashboard"
