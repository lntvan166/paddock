import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * One header band across the three tab screens.
 *
 * Measured in a browser at 390×844 before this landed: Agents 44px, Settings
 * 51px, Spaces 69px. Swiping between tabs moved the content under them by up
 * to 25px, which reads as the page settling rather than as three peers — and
 * it is far more visible now that a swipe puts two of them on screen at once.
 *
 * Each had grown its own way. `.host-head` was the only one declaring a
 * height; the other two were content-sized, and Spaces' 44px refresh control
 * pushed its band out by the difference. None of the three was wrong on its
 * own, which is exactly how this kind of drift survives review.
 *
 * These tests pin the SHARED declaration rather than any particular number: a
 * header that wants a different height has to say so by leaving the band,
 * which is a decision a reviewer can see.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const HEADS = [".host-head", ".spaces-head", ".settings-header"];

/** The body of the one rule that declares all three headers together. */
function sharedBand(): string {
  const hit = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => {
    const sels = (m[1] ?? "").split(",").map((x) => x.trim());
    return HEADS.every((h) => sels.includes(h));
  });
  if (hit === undefined) throw new Error("the three headers are no longer stated together");
  return hit[2] ?? "";
}

/** Every rule whose selector list contains `selector`, bodies joined. */
function bodiesFor(selector: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2] ?? "")
    .join("\n");
}

test("all three headers are declared in one rule", () => {
  expect(sharedBand()).toContain("min-height");
});

test("no header sets its own height", () => {
  // A local `min-height` beside the shared one is how the band silently stops
  // being a band: the rule still exists, and one screen quietly ignores it.
  const shared = sharedBand();
  for (const h of HEADS) {
    const own = bodiesFor(h).replace(shared, "");
    expect(own, `${h} declares a height of its own, outside the shared band`)
      .not.toContain("min-height");
    expect(own, `${h} declares its own vertical padding, which changes its height`)
      .not.toMatch(/padding(-block|-top|-bottom)?:/);
  }
});

test("the band clears a 44px control without growing", () => {
  // Spaces' header CONTAINS a tap-target-sized refresh button. If the band
  // were only as tall as the 2.75rem floor, that control plus any padding
  // would push it out again — which is the exact bug this fixes.
  const shared = sharedBand();
  const viaToken = /min-height:\s*var\(--head-h\)/.test(shared);
  const raw = viaToken
    ? /--head-h:\s*([\d.]+)rem/.exec(css)?.[1]
    : /min-height:\s*([\d.]+)rem/.exec(shared)?.[1];
  const band = Number(raw ?? 0);
  const padBlock = Number(/padding-block:\s*([\d.]+)rem/.exec(shared)?.[1] ?? "0");

  // The 1px border counts. `box-sizing: border-box` means `min-height`
  // includes it, so it eats into the room the control has — and leaving it out
  // of this sum is exactly how Spaces ended up one pixel taller than the other
  // two after the first attempt at this fix.
  const BORDER_REM = 1 / 16;
  expect(band, "could not read the band height").toBeGreaterThan(0);
  expect(
    band,
    `a 44px control, ${padBlock * 2}rem of padding and a 1px border do not fit in ${band}rem`,
  ).toBeGreaterThanOrEqual(2.75 + padBlock * 2 + BORDER_REM);
});

test("the band height is a token, not repeated by hand", () => {
  // Three screens agreeing by coincidence is what this replaced.
  expect(css).toContain("--head-h:");
  const at = css.indexOf("\n:root {");
  expect(at, "the token is not on bare :root").toBeGreaterThan(-1);
  expect(css.slice(at, css.indexOf("}", at))).toContain("--head-h:");
});
