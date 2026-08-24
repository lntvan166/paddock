import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * Touch-target and motion guards for the primitive layer, checked against the
 * stylesheet source.
 *
 * happy-dom implements no layout, so a rendered-DOM test cannot measure a
 * control's height. Reading the rule out of styles.css is the approach
 * tests/settings-styles.test.ts and tests/block-styles.test.ts already take:
 * it cannot prove the pixels, but it does stop the declaration being deleted
 * by someone who does not know why it is there.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2] ?? "");
  if (bodies.length === 0) throw new Error(`no CSS rule for "${selector}"`);
  return bodies.join("\n");
}

function declaration(selector: string, prop: string): string {
  const m = new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;}]+)`).exec(ruleBody(selector));
  if (!m) throw new Error(`"${selector}" declares no ${prop}`);
  return (m[1] ?? "").trim();
}

const TOUCH_TARGET = "2.75rem";

test("the switch is a full touch target", () => {
  expect(declaration(".toggle", "min-height")).toBe(TOUCH_TARGET);
});

test("the switch's motion is opt-out", () => {
  // A transition that ignores the preference is the one CLAUDE.md names.
  expect(css).toContain("prefers-reduced-motion");
  expect(ruleBody(".toggle-knob")).toContain("transition");
});

test("a disabled switch is dimmed as well as inert", () => {
  // Colour alone would leave the state invisible to anyone who cannot see the
  // difference; opacity plus the cursor is the second channel.
  expect(declaration(".toggle:disabled", "opacity")).toBeTruthy();
});

test("each segment is a full touch target", () => {
  expect(declaration(".seg-item", "min-height")).toBe(TOUCH_TARGET);
});

test("only the state that is in motion animates", () => {
  // `working` pulses because it is the state that is actually moving. Blocked
  // has STOPPED — pulsing it would say the opposite of what it means, and a
  // blocked agent already has a red border and a tinted fill asking for a
  // person. Done and idle are settled.
  expect(ruleBody('.dot[data-pulse="yes"]')).toContain("animation");
  // The halo is a separate painted ring rather than the dot itself scaling:
  // scaling the dot would move it, and a ring and a disc must occupy the same
  // box (see the .dot rule).
  expect(css).toContain("@keyframes dot-pulse");
});

test("the pulse is opt-out, not merely fast", () => {
  // The global reduced-motion block clamps animation-duration to 0.01ms, which
  // for a LOOPING animation means it still runs — thousands of times a second.
  // A keyframe animation needs `animation: none`, not a shorter duration.
  const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
  expect(reduced).toContain('.dot[data-pulse="yes"]');
  expect(reduced).toMatch(/\.dot\[data-pulse="yes"\][^}]*\{[^}]*animation:\s*none/);
});
