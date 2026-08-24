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
  // The guarantee is unchanged; where it lives moved. The knob's transition was
  // paddock's own rule until Radix took over the switch's internals — its thumb
  // animates with a Tailwind `transition-transform`, which no rule in this file
  // declares. What still has to hold is that the document-wide
  // prefers-reduced-motion block clamps EVERY transition and animation, rather
  // than each component opting in one at a time.
  const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
  expect(reduced).toMatch(/\*,?\s*\n?\s*\*::before/);
  expect(reduced).toContain("transition-duration");
  expect(reduced).toContain("animation-duration");
});

test("a disabled switch is dimmed as well as inert", () => {
  // Also moved rather than dropped: Radix marks its root `data-disabled`, and
  // shadcn's switch carries `data-disabled:opacity-50` and
  // `data-disabled:cursor-not-allowed`. Asserted against that component's
  // source, because the rule is no longer in this stylesheet at all — inert
  // without a visible change would leave a dead control looking live.
  const sw = readFileSync("src/web/components/shadcn/switch.tsx", "utf8");
  expect(sw).toContain("data-disabled:opacity-50");
  expect(sw).toContain("data-disabled:cursor-not-allowed");
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

test("paddock's own controls have a focus ring, like the shadcn ones do", () => {
  // There was no :focus or :focus-visible rule in this stylesheet at all. That
  // was survivable while every control was equally undefined; it stopped being
  // survivable when the shadcn components arrived with focus-visible:ring and
  // keyboard focus started looking deliberate on some controls and absent on
  // others two taps away.
  expect(css).toContain(":focus-visible");
  expect(css).toContain("var(--ring)");
});

test("nothing removes an outline without replacing it", () => {
  // The reason the ring can be additive: no rule here strips the browser's own.
  // `outline: none` with no replacement is the classic way a keyboard user
  // loses track of where they are.
  expect(css).not.toMatch(/outline:\s*(none|0)\b/);
});
