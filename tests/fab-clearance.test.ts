import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * The floating `+` must not sit on top of a row's controls.
 *
 * Reported from a phone: with a long agent list, the LAST row's `⋯` is
 * unreachable — the quick-add button covers it and there is no scroll left to
 * move the row out from under. Measured in a browser at 390×844 with eight
 * agents: the last `⋯` occupied y 734–770 and the button y 736–780, a 34px
 * overlap, at `scrollTop === scrollHeight`.
 *
 * A fixed overlay over a scroll container has to pay for its footprint in that
 * container's padding, or the last screenful of content is unreachable. This
 * repository has already learned that once, from the other end: the settings
 * save bar was a fixed overlay covering the last field, and the note left at
 * `.settings-save-bar` records it being made a flex sibling for exactly this
 * reason. A FAB cannot take that way out — floating over the content is the
 * whole point of it — so it pays in padding instead.
 *
 * The reservation is scoped by `:has()` to screens that actually HAVE the
 * button, so a screen without one keeps its full height. That follows
 * `.screen:has(.tab-bar)`, which is already in the stylesheet for the same
 * kind of "this screen carries an extra thing" reason.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2] ?? "");
  if (bodies.length === 0) throw new Error(`no CSS rule for "${selector}"`);
  return bodies.join("\n");
}

/** Every length in a declaration, in rem. `env(...)` fallbacks are ignored —
 *  the safe-area inset is below the tab bar, not between it and the button. */
function remsIn(decl: string): number[] {
  return [...decl.matchAll(/(\d*\.?\d+)rem/g)].map((m) => Number(m[1]));
}

test("a screen carrying the quick-add button reserves room for it", () => {
  const body = ruleBody(".screen:has(.quick-add-fab) > .screen-body");
  expect(body, "the scroll container reserves no bottom space").toContain("padding-bottom");
});

test("the reservation covers the button's whole footprint, not just its height", () => {
  // The button is 2.75rem tall and floats 0.75rem above the tab bar, so it
  // intrudes 3.5rem into the scroll container. Anything less and the last row
  // is still partly covered — which is the bug, just smaller.
  const reserved = remsIn(ruleBody(".screen:has(.quick-add-fab) > .screen-body"))
    .reduce((a, b) => a + b, 0);
  const fabHeight = 2.75, gapAboveTabBar = 0.75;
  expect(reserved).toBeGreaterThanOrEqual(fabHeight + gapAboveTabBar);
});

test("the reservation is derived from the button's own numbers", () => {
  // Spelled as a sum whose terms match the button's real height and offset,
  // rather than one rounded figure. The `.quick-add-fab` block already sets
  // its `bottom` this way, with the note "expressed as that sum rather than a
  // guessed number" — if someone resizes the button, a bare `4.25rem` here
  // gives no hint that it also has to change.
  const body = ruleBody(".screen:has(.quick-add-fab) > .screen-body");
  expect(body, "reservation is a magic number, not a derivation").toContain("calc(");

  const fab = ruleBody(".quick-add-fab");
  const height = /height:\s*([\d.]+)rem/.exec(fab)?.[1];
  expect(height, "could not read the button's height").toBeDefined();
  expect(body, `the button is ${height}rem tall but the reservation never mentions it`)
    .toContain(`${height}rem`);
});

test("only screens with the button pay for it", () => {
  // A bare `.screen-body { padding-bottom }` would push Spaces, Settings and
  // every terminal screen up by a button's height for no reason.
  const scoped = css.includes(".screen:has(.quick-add-fab)");
  expect(scoped, "the reservation is not scoped to screens that have the button").toBe(true);
});
