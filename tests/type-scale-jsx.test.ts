import { expect, test } from "bun:test";

/**
 * The type scale reaches the COMPONENTS, not just the stylesheet.
 *
 * `tests/tokens.test.ts` enforces the four-step scale — and reads only
 * `src/web/styles.css`. So five components went on setting type in raw pixels,
 * which is the exact pattern the scale was introduced to remove:
 *
 *   ConnectionBanner  text-[11px]   "Reconnecting… last update 2m ago"
 *   ReleaseBanner     text-[11px]   "paddock 0.11.0 is available"
 *   InstallHint       text-[11px]   "Add paddock to your Home Screen"
 *   App.tsx (x2)      text-[11px]   "Opening…" and "No agents detected."
 *
 * Not a cosmetic leftover. Every one of those strings is a SENTENCE — a
 * connection warning, an update notice, an install prompt, an empty state —
 * and the scale's own definitions put `--t-xs` at "eyebrows, ages, counts,
 * badges: metadata" and `--t-md` at "anything you read". All five sat one step
 * below what the app's own rule prescribes, which is why the banners read as
 * fine print rather than as messages.
 *
 * The stylesheet comment introducing the scale says it plainly:
 *
 *   "the dashboard's type was text-[9.5px], text-[10px], text-[11px],
 *    text-[12.5px] and text-[13px] — five sizes inside a 3.5px range …
 *    Half-pixel sizes are the tell that nothing was scaled, things were
 *    nudged until they fit."
 *
 * The migration cleaned the CSS and left the JSX, and nothing was watching.
 */

/** shadcn's own files are vendored — they carry `text-[0.8rem]` in their
 *  variant tables and are not ours to restyle. Excluded by path, deliberately
 *  and visibly, rather than by making the pattern looser. */
const VENDORED = "src/web/components/shadcn/";

test("no component sets type in raw pixels", async () => {
  const glob = new Bun.Glob("src/web/**/*.{ts,tsx}");
  const offenders: string[] = [];

  for await (const file of glob.scan(".")) {
    if (file.startsWith(VENDORED)) continue;
    const text = await Bun.file(file).text();
    for (const [i, line] of text.split("\n").entries()) {
      // Tailwind's arbitrary font-size — `text-[11px]`, `text-[0.8rem]`.
      // Deliberately not matching `text-[var(--t-md)]`, which is on the scale.
      const m = /text-\[(?!var\()([^\]]+)\]/.exec(line);
      if (m) offenders.push(`${file}:${i + 1}  text-[${m[1]}]`);
      // An inline style that hardcodes a size, the same defect by another route.
      const s = /fontSize:\s*["'](\d)/.exec(line);
      if (s) offenders.push(`${file}:${i + 1}  fontSize literal`);
    }
  }

  expect(
    offenders,
    "use a --t-* step (var(--t-xs|md|lg|xl)); the scale exists so type is not nudged until it fits",
  ).toEqual([]);
});
