#!/bin/sh
# paddock installer. Downloads the release binary for this platform, verifies
# its checksum, and installs it to ~/.local/bin.
#
# Read before running:
#   curl -fsSL https://lntvan166.github.io/paddock/install.sh | less
#
# No sudo. ~/.local/bin is user-writable, so nothing here needs privilege
# escalation — a one-liner that asks for root to install a dashboard is a
# habit worth not teaching.
set -eu

REPO="lntvan166/paddock"
BIN_DIR="${PADDOCK_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/paddock"

# Overridable so the platform table can be tested without four machines.
UNAME_S="${PADDOCK_UNAME_S:-$(uname -s)}"
UNAME_M="${PADDOCK_UNAME_M:-$(uname -m)}"

# Overridable so the download -> verify -> install pipeline can be tested
# offline, with a stub that copies fixture bytes instead of a real network call.
CURL="${PADDOCK_CURL:-curl}"

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

BASE="https://github.com/$REPO/releases/latest/download"

# The binary is downloaded INTO the destination directory, under a dot name,
# so the final step is a rename(2) within one filesystem — atomic, exactly as
# `paddock update` does it (src/server/update.ts writes .paddock.new beside the
# binary and renames over it).
#
# The obvious alternative, `mv "$TMP/paddock" "$BIN"` out of `mktemp -d`, is
# not atomic: $TMPDIR is usually a different filesystem from $HOME, so
# rename(2) fails EXDEV and mv degrades to a byte-by-byte copy made DIRECTLY at
# the install path. Traced: `renameat2(...) = -1 EXDEV` followed by
# `openat("<bindir>/paddock", O_WRONLY|O_CREAT|O_EXCL)`. Interrupted, or out of
# disk, that leaves a truncated file at ~/.local/bin/paddock — executable, on
# PATH, and half a binary.
#
# SHA256SUMS stays in $TMP: it is read, never installed, so where it lands does
# not matter.
mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
NEW="$BIN_DIR/.paddock.new.$$"
trap 'rm -rf "$TMP"; rm -f "$NEW"' EXIT

# `curl -fsSL` says NOTHING on an HTTP error — `-f` suppresses the error body
# and `-s` suppresses curl's own message — and `set -e` then ends the script
# before anything can be printed. The operator saw "paddock: downloading
# paddock-linux-x86_64" and then a bare non-zero exit. The likeliest first-run
# case is exactly this: installing before a release with assets exists.
#
# `-w '%{http_code}'` makes the status available even on the failure path, and
# the `|| rc=$?` form keeps `set -e` from killing us before we can use it.
download() {
  url="$1"
  dest="$2"
  rc=0
  code="$("$CURL" -fsSL -w '%{http_code}' -o "$dest" "$url")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "paddock: download failed" >&2
    echo "  url         $url" >&2
    echo "  http status ${code:-000}" >&2
    echo "  curl exit   $rc" >&2
    echo "" >&2
    echo "paddock: if no release has been published yet there is nothing to install." >&2
    echo "  check https://github.com/$REPO/releases" >&2
    exit 1
  fi
}

echo "paddock: downloading $ASSET"
download "$BASE/$ASSET" "$NEW"
download "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"

echo "paddock: verifying checksum"
EXPECTED="$(grep " $ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}')"
if [ -z "$EXPECTED" ]; then
  echo "paddock: $ASSET is not listed in SHA256SUMS — refusing to install" >&2
  exit 1
fi
if command -v sha256sum >/dev/null; then
  ACTUAL="$(sha256sum "$NEW" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$NEW" | awk '{print $1}')"
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "paddock: CHECKSUM MISMATCH — refusing to install" >&2
  echo "  expected $EXPECTED" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi

chmod +x "$NEW"
# Same directory, so this is a rename(2): the old binary is replaced whole or
# not at all, and nothing else ever observes a partial file at $BIN. The EXIT
# trap's `rm -f "$NEW"` is a no-op afterwards, and cleans up every path where
# this line is not reached.
mv "$NEW" "$BIN"
echo "paddock: installed to $BIN"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""
     echo "paddock: $BIN_DIR is not on your PATH. Add this to your shell profile:"
     echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo "paddock: run 'paddock' to start the dashboard"
