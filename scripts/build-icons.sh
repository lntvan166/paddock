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

# --- The icon URL version. -------------------------------------------------
#
# iOS keeps favicons and apple-touch-icons in a per-URL icon store that
# Cache-Control never reaches. `no-cache` on the response does not make Safari
# refetch one, and a Home Screen shortcut freezes its icon at the moment it is
# added. The only thing that invalidates either is a DIFFERENT URL, so the
# rasters carry the version in their filename.
#
# Bump this whenever the mark changes in a way anyone should see. Leaving it
# alone ships new bytes under an old name, which desktop browsers pick up and
# iOS does not — a redesign that looks deployed everywhere except on the phones
# the dashboard is built for.
#
# v1 is the unversioned era (`favicon-32.png` and friends); those names are
# retired and not served.
ICON_V=2

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

# --- The markup must name the files this run will write. -------------------
#
# A bump that lands in the rasters but not in the markup links icons that 404:
# no icon at all, which is worse than a stale one and every bit as quiet. Fail
# before rendering, so a forgotten edit cannot half-apply.
#
# index.html carries the favicon and apple-touch-icon links; the manifest
# carries the three PWA icons. Each referrer is checked for its own files.

check_referenced() {
  local referrer="$1" name="$2"
  if ! grep -qF "$name" "$referrer"; then
    echo "build-icons: $referrer does not reference $name." >&2
    echo "ICON_V is $ICON_V, so every icon URL in $referrer needs the" >&2
    echo "-v$ICON_V suffix. Update it and rerun. Until then Safari keeps" >&2
    echo "serving the previous mark from its icon store, because nothing ever" >&2
    echo "asks it for a URL it has not already cached." >&2
    exit 1
  fi
}

check_referenced index.html                 "favicon-32-v$ICON_V.png"
check_referenced index.html                 "favicon-180-v$ICON_V.png"
check_referenced index.html                 "apple-touch-icon-v$ICON_V.png"
check_referenced public/manifest.webmanifest "icon-192-v$ICON_V.png"
check_referenced public/manifest.webmanifest "icon-512-v$ICON_V.png"
check_referenced public/manifest.webmanifest "icon-maskable-512-v$ICON_V.png"

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

scale "$TMP/master.png"    32 "public/favicon-32-v$ICON_V.png"
scale "$TMP/master.png"   180 "public/favicon-180-v$ICON_V.png"
scale "$TMP/master.png"   180 "public/apple-touch-icon-v$ICON_V.png"
scale "$TMP/master.png"   192 "public/icon-192-v$ICON_V.png"
scale "$TMP/master.png"   512 "public/icon-512-v$ICON_V.png"
scale "$TMP/maskable.png" 512 "public/icon-maskable-512-v$ICON_V.png"

# docs/images/logo.png is README artwork, not a browser icon. Nothing is holding
# it in an icon store, and a version would churn the filename in the README on
# every bump for no gain.
scale "$TMP/master.png"   480 docs/images/logo.png

# --- Retire the rasters of older versions. --------------------------------
#
# Left behind, they would be committed and served as a second, permanently
# stale copy of the mark under a URL nothing links — precisely what versioning
# the name is here to end.

for stale in public/favicon-32*.png public/favicon-180*.png \
             public/apple-touch-icon*.png public/icon-192*.png \
             public/icon-512*.png public/icon-maskable-512*.png; do
  case "$stale" in
    *"-v$ICON_V.png") continue ;;
  esac
  [ -e "$stale" ] || continue   # an unmatched glob stays literal
  rm "$stale"
  echo "  removed $stale (superseded by v$ICON_V)"
done

echo "build-icons: done. dist/ and dist-demo/ are build output — rerun the web"
echo "build to pick these up; do not copy them by hand."
