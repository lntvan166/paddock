import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * One gutter, everywhere.
 *
 * Measured before this branch, a line of content started at SEVEN different
 * distances from the screen edge: 9.6px (`.term-controls`, `.term-keys`),
 * 11.2px (`.term-pane`), 12px (the dashboard rows and three screen headers),
 * 14.4px (`.row-actions-*`, `.create-form`), 18.4px (the terminal's back
 * label), 19.2px (`.term-options` content) and 20px (an `AgentCard`, from
 * `mx-2` plus `p-3`).
 *
 * None of those is wrong on its own. The cost is that the eye tracks the
 * leftmost edge of a column to stay oriented while scrolling, so seven edges
 * read as a list that will not sit still — most visibly on the dashboard,
 * where the icon column jogged sideways between an attention card and the row
 * beneath it.
 *
 * These tests pin the SHARED value rather than any particular number: a rule
 * that wants a different horizontal inset has to say so out loud by not using
 * the token, which is a decision a reviewer can see.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2] ?? "");
  if (bodies.length === 0) throw new Error(`no CSS rule for "${selector}"`);
  return bodies.join("\n");
}

test("the gutter is a token on bare :root, not buried in a media query", () => {
  // Located by string rather than through `ruleBody`, which cannot see this
  // block: the selector regex is brace-delimited, and the `@custom-variant`
  // line above `:root` ends in `));`, so the captured "selector" is that whole
  // line plus `:root` and matches nothing. That is a quirk of the shared
  // helper, not of this rule — every other test using it looks at a class.
  const at = css.indexOf("\n:root {");
  expect(at, "no bare :root block").toBeGreaterThan(-1);
  const block = css.slice(at, css.indexOf("}", at));
  expect(block).toContain("--gutter:");

  // Declared exactly once. A second definition is how a token stops being one.
  expect(css.match(/--gutter\s*:/g)?.length).toBe(1);
});

/**
 * Every band that spans the screen and holds content the reader scans down.
 *
 * The terminal's OUTPUT PANE is deliberately absent: it is a viewport onto
 * what the agent drew, not a column of paddock's own text, and its exemption
 * is asserted below rather than left implicit.
 */
const BANDS = [
  // Dashboard
  ".row",
  ".agent-card",
  ".sec-head",
  ".host-head",
  // Terminal
  ".term-header",
  ".term-controls",
  ".term-keys",
  ".term-reply",
  ".term-options",
  // A fragment, not the whole list: `ruleBody` splits selector lists on
  // commas, so the shared `.term-error, .term-note` rule is matched by either.
  ".term-error",
  // Screen headers and footers
  ".spaces-head",
  ".settings-header",
  ".space-screen-head",
  // `.spaces-foot` was here. It is gone: the space count and the read-time
  // moved into `.spaces-head`, beside the word they describe, so there is no
  // footer band left to align.
  // Settings content
  ".band",
  ".card-head",
  ".card-body",
  ".card-foot",
  ".settings-save-bar",
  ".notify-transports",
  // Sheets
  ".row-actions-head",
  ".row-actions-menu > button",
  ".create-form",
  ".create-row",
  // Banners: a message spanning the screen is a band like any other
  ".update-bar",
  ".settings-banner",
  ".error",
  ".launch-notice",
  ".banner",
];

for (const sel of BANDS) {
  test(`${sel} starts its content at the shared gutter`, () => {
    const body = ruleBody(sel);
    // Either shorthand `padding: <block> var(--gutter)` or an explicit
    // inline/left+right pair — both are fine, a literal is not.
    const usesToken =
      /padding\s*:\s*[^;]*var\(--gutter\)/.test(body) ||
      /padding-inline\s*:\s*var\(--gutter\)/.test(body);
    expect(usesToken, `${sel} must inset by var(--gutter), not a literal`).toBe(true);
  });
}

/**
 * A band that carries the attention edge has to subtract it again.
 *
 * A border displaces the content behind it, so `border-left: 2px` on top of
 * `padding-left: var(--gutter)` puts that band's first pixel at gutter + 2 —
 * an `AgentCard`'s tile measured 18px against every row's 16px. Smaller than
 * the 8px jog this work removed, and the same defect.
 */
for (const sel of [".agent-card", ".term-options"]) {
  test(`${sel} subtracts its accent edge from its own gutter`, () => {
    const body = ruleBody(sel);
    expect(body).toContain("border-left: var(--edge)");
    expect(body).toContain("padding-left: calc(var(--gutter) - var(--edge))");
  });
}

test("the terminal's output pane is full-bleed, and that is deliberate", () => {
  // The pane is measured in COLUMNS VISIBLE — its own font-size comment records
  // that the floor was corrected once because ~46 columns clipped an 80-column
  // TUI mid-word. Horizontal padding there costs columns for no gain: the text
  // inside is the agent's, already aligned by construction, and it scrolls
  // sideways rather than wrapping. So this is the one band that opts out.
  const body = ruleBody(".term-pane");
  expect(body).not.toContain("var(--gutter)");
  expect(body).toMatch(/padding\s*:\s*[^;]*\s0\b/);
});
