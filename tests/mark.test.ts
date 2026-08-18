import { expect, test } from "bun:test";

/**
 * The mark's geometry exists in three places: `assets/logo.svg` (the master
 * every PNG is built from), `assets/logo-maskable.svg`, and `Mark.tsx` (the
 * in-app copy, which cannot simply import the SVG because it recolours the
 * figure to `currentColor`).
 *
 * `scripts/build-icons.sh` already fails if the two SVGs diverge. This is that
 * guard extended to the third copy: without it, editing the master would
 * silently leave the header rendering the old shape, and nothing would say so
 * until someone put the favicon and the header side by side.
 *
 * Geometry only. The colours are deliberately different — see Mark.tsx.
 */

const attr = (tag: string, name: string): string =>
  new RegExp(`\\s${name}="([^"]+)"`).exec(tag)?.[1] ?? "-";

/** Every drawn shape, as a normalised string. Order matters; colour does not. */
function geometry(source: string): string[] {
  const paths = [...source.matchAll(/\sd="([^"]+)"/g)].map(
    (m) => `path ${m[1]!.replace(/\s+/g, " ").trim()}`,
  );
  const rects = [...source.matchAll(/<rect\b[^>]*>/g)].map((m) => {
    const tag = m[0];
    return `rect ${["x", "y", "width", "height", "rx"]
      .map((a) => `${a}=${attr(tag, a)}`)
      .join(" ")}`;
  });
  return [...paths, ...rects];
}

test("Mark.tsx carries the same geometry as the SVG master it was copied from", async () => {
  const master = await Bun.file("assets/logo.svg").text();
  const mark = await Bun.file("src/web/components/Mark.tsx").text();

  // Only the shared glyph block — the master's 512x512 ground rect is not part
  // of it, and Mark.tsx deliberately omits that rect entirely.
  const glyph = /<!-- glyph:start -->([\s\S]*?)<!-- glyph:end -->/.exec(master)?.[1];
  expect(glyph, "assets/logo.svg lost its glyph:start/glyph:end markers").toBeTruthy();

  expect(geometry(mark)).toEqual(geometry(glyph!));
});

test("the master still paints a ground rect that Mark.tsx omits", async () => {
  // Guards the one intentional structural difference. If the master ever drops
  // its ground, the reason Mark.tsx differs has gone away and this should be
  // revisited rather than silently kept.
  const master = await Bun.file("assets/logo.svg").text();
  const beforeGlyph = master.slice(0, master.indexOf("<!-- glyph:start -->"));
  expect(beforeGlyph).toContain('width="512" height="512"');
});
