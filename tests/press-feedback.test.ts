import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * A tap should look like it landed.
 *
 * paddock had seven transitions in the whole stylesheet, and none on the
 * controls a finger actually hits. Tapping an agent row did nothing visible
 * until the next screen painted — which on a slow link reads as a missed tap,
 * and invites a second one.
 *
 * `:active`, never `:hover`. `CLAUDE.md` bans hover-only affordances because
 * they are invisible on touch, and a hover state on a phone latches after the
 * tap and stays lit, which reads as "still selected" on a row the operator has
 * already left.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2] ?? "");
  if (bodies.length === 0) throw new Error(`no CSS rule for "${selector}"`);
  return bodies.join("\n");
}

test("a pressed row responds", () => {
  const body = ruleBody(".row-open:active");
  expect(body).toMatch(/background|transform/);
});

test("the row's press is not a hover", () => {
  expect(css).not.toContain(".row-open:hover");
});

test("press feedback is fast enough to feel like a response", () => {
  // Past ~150ms it stops reading as an acknowledgement and becomes an
  // animation, which is a different thing and a worse one here.
  const body = ruleBody(".row-open");
  const ms = [...body.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
  expect(ms.length, "the row has no transition to feel").toBeGreaterThan(0);
  expect(Math.max(...ms)).toBeLessThanOrEqual(150);
});

test("the ⋯ and the tabs respond too", () => {
  // The row is the most-tapped control but not the only one. A row that
  // responds beside a menu button that does not reads as the button being
  // broken.
  expect(ruleBody(".row-actions-btn:active")).toMatch(/transform|background/);
  expect(ruleBody(".tab-item:active")).toMatch(/transform|background/);
});

test("every pressed control has something to ease the press", () => {
  // An `:active` rule with no `transition` on the base selector SNAPS — it
  // still changes, so a test that only checks the `:active` rule exists passes
  // while the control jerks. That is exactly what happened to `.tab-item`
  // here, and this is the assertion that would have caught it.
  for (const sel of [".row-open", ".row-actions-btn", ".icon-tile", ".tab-item"]) {
    expect(ruleBody(sel), `${sel} has :active styling but no transition to ease it`)
      .toContain("transition");
  }
});

test("every press transition is inside the reduced-motion clamp", () => {
  // The clamp is a universal selector, so this is really a guard that nobody
  // has added an `!important` that escapes it.
  const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(at, "the reduced-motion clamp is gone").toBeGreaterThan(-1);
  const block = css.slice(at, at + 400);
  expect(block).toContain("transition-duration");
  expect(block).toContain("!important");
});

test("the pager's settle is covered by the clamp too", () => {
  // `.pager-track.is-settling` carries a transition like any other, and the
  // universal clamp reaches it. Asserted because a track that keeps sliding
  // for someone who asked for no motion is the most obvious possible breach.
  expect(css).toContain(".pager-track.is-settling");
  const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
  const block = css.slice(at, at + 400);
  expect(block).toMatch(/\*[\s,]/);
});
