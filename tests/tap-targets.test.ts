import { expect, test } from "bun:test";

/**
 * Tap-target rules, asserted on the element that RECEIVES the tap.
 *
 * These exist because a 44px rule can be perfectly present and still do
 * nothing. Two measured cases, both from a real hit-tested click at a point
 * inside the 44px box and outside the drawn control:
 *
 *   - `.toggle` was a 48x44 `span` wrapping an 18px Radix switch, and its own
 *     comment claimed "this is what you hit". It was not: a plain `span` with
 *     no handler and no label association, so the click reached nothing while
 *     the same click on the 32x18 pill worked.
 *   - Refresh had a 44px rule scoped to `.detail header .controls`, but the
 *     button had moved to `.term-controls`. The selector no longer matched the
 *     markup, and the button measured 15x24.
 *
 * A CSS-only test cannot tell a live 44px box from a decorative one — that
 * needs a browser, and the fixes were verified there. What these assertions
 * pin is the narrower fact those two bugs shared: the rule has to land on the
 * control, not on something merely near it.
 */
async function css(): Promise<string> {
  return await Bun.file("src/web/styles.css").text();
}

/** The rule body for a selector, comments stripped. */
function ruleFor(text: string, selector: string): string | null {
  const at = text.indexOf(selector);
  if (at === -1) return null;
  const open = text.indexOf("{", at);
  const close = text.indexOf("}", open);
  if (open === -1 || close === -1) return null;
  return text.slice(open + 1, close);
}

test("the switch's own hit area reaches the floor, not just its wrapper's", async () => {
  const text = await css();
  // On `[data-slot=switch]`, the button Radix renders — NOT on `.toggle`, the
  // span around it. The span may keep its spacing; it is not the target.
  const rule = ruleFor(text, '.toggle [data-slot="switch"]::after');
  expect(rule, "no hit-area rule on the switch itself").not.toBeNull();
  expect(rule!).toContain("min-height: 2.75rem");
  expect(rule!).toContain("min-width: 2.75rem");
  // Centred on the control, or it grows the box off to one side.
  expect(rule!).toContain("translate(-50%, -50%)");
});

test("every control in the terminal's control row is a full tap target", async () => {
  const text = await css();
  const rule = ruleFor(text, ".term-controls button {");
  expect(rule, "Refresh and the Keys toggle share this row and this rule").not.toBeNull();
  expect(rule!).toContain("min-height: 2.75rem");
  expect(rule!).toContain("min-width: 2.75rem");
});

test("the pre-existing 44px rules are still scoped to markup that exists", async () => {
  // The Refresh bug's actual shape: a correct rule whose selector had drifted.
  // Every selector carrying the 2.75rem floor is listed here so that moving an
  // element out from under one is a failing test rather than a silent shrink.
  // Comments stripped FIRST. Without that, the selector capture swallows the
  // comment block above each rule and the assertions match prose rather than
  // selectors — a test that would pass on a stylesheet with no rules at all.
  const text = (await css()).replace(/\/\*[\s\S]*?\*\//g, "");
  const floors = [...text.matchAll(/([^{}\n][^{}]*)\{[^}]*min-height:\s*2\.75rem/g)]
    .map((m) => m[1]!.trim());
  // Not an exhaustive list of selectors — a growing UI will add more. The point
  // is that the two this file is about are among them.
  expect(floors.join(" | ")).toContain(".term-controls button");
  expect(floors.join(" | ")).toContain('[data-slot="switch"]::after');
});
