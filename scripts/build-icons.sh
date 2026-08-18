#!/usr/bin/env bash
# Derive every icon raster from assets/logo.svg. Run after editing the master:
#
#   make icons
#
# The rasters in public/ and docs/images/ are committed (the server ships them
# and GitHub renders the README without a build step), so this script is not
# part of `make build` — it is run by hand when the mark changes, and its output
# is reviewed like any other change.
#
# Nothing here is allowed to fail quietly. There is no `2>/dev/null`, no
# unconditional `exit 0`, and no fallback that produces a wrong-looking icon
# instead of an error: a silently mis-rendered favicon is exactly the kind of
# breakage nobody notices for months.
set -euo pipefail

cd "$(dirname "$0")/.."

MASTER="assets/logo.svg"
MASKABLE="assets/logo-maskable.svg"

for f in "$MASTER" "$MASKABLE"; do
  if [ ! -f "$f" ]; then
    echo "build-icons: missing $f — the rasters are derived from it, so there is nothing to build" >&2
    exit 1
  fi
done

# --- The two masters must share one glyph. --------------------------------
#
# logo-maskable.svg is logo.svg inset for the launcher's circular crop. The only
# legitimate difference is the wrapping transform; if the glyph itself diverges,
# the app icon and the home-screen icon become two different marks, which is
# both a bug and invisible until someone installs the PWA. Compare and refuse.

glyph() { sed -n '/glyph:start/,/glyph:end/p' "$1"; }

if ! diff <(glyph "$MASTER") <(glyph "$MASKABLE") > /dev/null; then
  echo "build-icons: the glyph blocks in $MASTER and $MASKABLE have diverged." >&2
  echo "Copy the block between the glyph:start and glyph:end markers from" >&2
  echo "$MASTER into $MASKABLE, leaving the wrapping transform alone. Diff:" >&2
  diff <(glyph "$MASTER") <(glyph "$MASKABLE") >&2 || true
  exit 1
fi

# The ground is the full-bleed rect, and it sits OUTSIDE the glyph block — the
# maskable file wraps the glyph in a transform, and scaling the background with
# it would defeat the point. So the check above cannot see the ground, and
# recolouring one file's ground alone would ship a home-screen icon on a
# different colour from the app icon. Compare it separately.

ground() { sed -n 's/.*<rect width="512" height="512" fill="\(#[0-9A-Fa-f]\{6\}\)".*/\1/p' "$1"; }

MASTER_GROUND=$(ground "$MASTER")
MASKABLE_GROUND=$(ground "$MASKABLE")

if [ -z "$MASTER_GROUND" ] || [ -z "$MASKABLE_GROUND" ]; then
  echo "build-icons: could not read the ground colour from both masters." >&2
  echo "Each needs a full-bleed <rect width=\"512\" height=\"512\" fill=\"#rrggbb\">." >&2
  exit 1
fi

if [ "$MASTER_GROUND" != "$MASKABLE_GROUND" ]; then
  echo "build-icons: the grounds differ — $MASTER is $MASTER_GROUND and" >&2
  echo "$MASKABLE is $MASKABLE_GROUND. Recolour both, or the app icon and the" >&2
  echo "home-screen icon ship on different backgrounds." >&2
  exit 1
fi

# --- Pick a rasteriser. ----------------------------------------------------
#
# Preference order is by SVG fidelity. librsvg and Inkscape are real SVG
# renderers; headless Chrome is the browser engine the icons are actually viewed
# in, so it is a trustworthy third. ImageMagick is deliberately NOT a fallback
# for this step: without a librsvg delegate it renders SVG with its own crude
# parser and silently drops strokes, which would produce a plausible-looking but
# wrong icon. It is used only for downscaling rasters, which it does well.

RENDERER=""
for candidate in rsvg-convert inkscape chromium chromium-browser google-chrome; do
  if command -v "$candidate" > /dev/null; then
    RENDERER="$candidate"
    break
  fi
done

if [ -z "$RENDERER" ]; then
  echo "build-icons: no SVG rasteriser found." >&2
  echo "Install one of: rsvg-convert (librsvg2-bin), inkscape, or a chromium build." >&2
  exit 1
fi

if ! command -v convert > /dev/null; then
  echo "build-icons: ImageMagick 'convert' not found; it is needed to downscale." >&2
  echo "Install imagemagick." >&2
  exit 1
fi

echo "build-icons: rendering with $RENDERER"

# render <svg> <size> <out>
render() {
  local svg="$1" size="$2" out="$3"
  case "$RENDERER" in
    rsvg-convert)
      rsvg-convert --width "$size" --height "$size" --output "$out" "$svg"
      ;;
    inkscape)
      inkscape --export-type=png --export-filename="$out" \
               --export-width="$size" --export-height="$size" "$svg"
      ;;
    chromium | chromium-browser | google-chrome)
      # --force-device-scale-factor=1 keeps the screenshot at CSS pixel size on a
      # HiDPI machine, where it would otherwise come out 2x and be silently
      # downscaled later, softening the small sizes.
      "$RENDERER" --headless=new --disable-gpu --hide-scrollbars \
                  --force-device-scale-factor=1 \
                  --screenshot="$out" --window-size="$size,$size" "$svg" > /dev/null
      ;;
  esac
  if [ ! -s "$out" ]; then
    echo "build-icons: $RENDERER produced no output for $out" >&2
    exit 1
  fi
}

# Small sizes are downscaled from one large render rather than rendered directly.
# A 32px direct render puts the rail edges on fractional pixels and comes out
# either bitten or blurred; Lanczos from a big source keeps them even.
#
# That source is 512 because it is the masters' intrinsic width, and Chrome
# honours intrinsic size: asking for a 1024 window renders the 512 document into
# the top-left corner and pads the rest, which silently produced an icon with
# the mark in one quadrant. 512 is also the largest size anything here needs.
SOURCE_PX=512
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

render "$MASTER"   "$SOURCE_PX" "$TMP/master.png"
render "$MASKABLE" "$SOURCE_PX" "$TMP/maskable.png"

# --- Prove the render is the mark, not a failure that happens to be a PNG. ---
#
# A rasteriser that hits a malformed SVG does not necessarily exit non-zero: both
# Chrome and librsvg will happily screenshot an XML parser error page, which is a
# valid, non-empty PNG. That is how a double hyphen in a comment once turned
# every icon in this repo into a pink error card.
#
# The lit rail segment is the one colour that appears nowhere else in the mark,
# so finding it in the output proves the artwork rendered. The expected value is
# read back out of the master rather than hardcoded here, so recolouring the
# segment cannot leave this check silently testing the wrong thing.
#
# An earlier version of this asked ImageMagick for %[opaque] after making the
# cursor transparent. That looked reasonable and tested nothing: %[opaque]
# reports false whenever an alpha channel exists at all, so it said "false" for
# a correct icon and for an error page alike. Counting exact pixels in the
# histogram does discriminate — 1 versus 0 on the two cases.

LIT_HEX=$(sed -n 's/.*id="lit".*fill="#\([0-9A-Fa-f]\{6\}\)".*/\1/p' "$MASTER")
if [ -z "$LIT_HEX" ]; then
  echo "build-icons: could not read the lit colour from $MASTER." >&2
  echo "The render check needs a rect with id=\"lit\" and a 6-digit hex fill." >&2
  exit 1
fi

assert_mark_rendered() {
  local png="$1" hits
  # -depth 8 forces 8-bit hex in the histogram; this is a Q16 build of
  # ImageMagick, which would otherwise print each channel doubled.
  hits=$(convert "$png" -depth 8 -format %c histogram:info:- | grep -ci "$LIT_HEX" || true)
  if [ "$hits" -eq 0 ]; then
    echo "build-icons: $png contains no #$LIT_HEX, so it is not the mark." >&2
    echo "The rasteriser most likely rendered an error page instead of failing." >&2
    echo "Check $MASTER for malformed XML — a double hyphen inside a comment is" >&2
    echo "illegal and is the usual cause." >&2
    exit 1
  fi
}

assert_mark_rendered "$TMP/master.png"
assert_mark_rendered "$TMP/maskable.png"

# scale <source> <size> <out>
scale() {
  convert "$1" -filter Lanczos -resize "${2}x${2}" -strip "$3"
  echo "  $3 (${2}px)"
}

scale "$TMP/master.png"    32 public/favicon-32.png
scale "$TMP/master.png"   180 public/favicon-180.png
scale "$TMP/master.png"   180 public/apple-touch-icon.png
scale "$TMP/master.png"   192 public/icon-192.png
scale "$TMP/master.png"   512 public/icon-512.png
scale "$TMP/maskable.png" 512 public/icon-maskable-512.png
scale "$TMP/master.png"   480 docs/images/logo.png

echo "build-icons: done. dist/ and dist-demo/ are build output — rerun the web"
echo "build to pick these up; do not copy them by hand."
