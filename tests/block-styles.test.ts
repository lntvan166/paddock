import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { groupLines, type BlockKind } from "@web/lines";

// The renderer builds its class as `term-${block.kind}`, so a kind with no
// matching CSS rule renders with NO styling at all — and the failure is
// silent and severe: a table falls back to the pane's `white-space: normal`,
// collapses its columns, and looks like corrupted output rather than a
// missing stylesheet rule.
//
// That shipped once. Adding the `rule` kind renamed the structure class from
// `.term-strip` to `.term-structure` in the JSX without renaming it in the
// CSS, and the check that should have caught it queried `.term-strip`, found
// none, and read that as success.

const ALL_KINDS: BlockKind[] = ["prose", "structure", "rule"];

test("groupLines only ever emits kinds this test knows about", () => {
  // Guards the guard: a NEW kind added to lines.ts must be added here too,
  // or the CSS check below would pass while ignoring it.
  const lines = ["prose", "│ a │ b │", "────────", "", "  ████░░░░"];
  for (const b of groupLines(lines)) {
    expect(ALL_KINDS).toContain(b.kind);
  }
});

test("every block kind has a CSS rule, or it renders unstyled", () => {
  const css = readFileSync("src/web/styles.css", "utf8");
  for (const kind of ALL_KINDS) {
    expect(css).toContain(`.term-${kind}`);
  }
});

test("structure and rule pin the properties that make them work", () => {
  const css = readFileSync("src/web/styles.css", "utf8");
  const ruleFor = (sel: string) => {
    // Anchored at a line start. `indexOf(".term-structure {")` also matches
    // inside a grouped selector like `.term-pane, .term-structure {`, and if
    // such a group appears earlier in the file this reads THAT rule's body and
    // asserts against the wrong declarations — which is exactly what happened
    // when the pane and the strip briefly shared a scrollbar rule.
    const at = css.indexOf(`\n${sel} {`);
    expect(at, `no rule begins a line with \`${sel} {\``).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  // Structure must never reflow, and must scroll on its own.
  const structure = ruleFor(".term-structure");
  expect(structure).toContain("white-space: pre");
  expect(structure).toContain("overflow-x: auto");

  // Decoration must never reflow either, but must NOT scroll — scrolling a
  // line of dashes only reveals more dashes.
  const rule = ruleFor(".term-rule");
  expect(rule).toContain("white-space: pre");
  expect(rule).toContain("overflow: hidden");

  // Prose is the only kind allowed to reflow.
  expect(ruleFor(".term-prose")).toContain("pre-wrap");
});

test("the terminal is constrained to a column, not stretched to the viewport", () => {
  // On a 1440px laptop an unconstrained `.term` produced option buttons 1400px
  // wide with their labels stranded at the far left. The list already centres
  // itself at this width, so an unconstrained terminal also made the two views
  // disagree about how wide the app is.
  //
  // The declarations live on the SHARED shell rule (`.screen, .term`) rather
  // than in a `.term` block of their own — every screen is a fixed, centred
  // column now, and the terminal was only the first. So this matches the
  // selector LIST rather than the literal string ".term {", which is what an
  // earlier version of this test did: it went red when the rule was shared,
  // even though the constraint it guards was untouched.
  const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").map((x) => x.trim()).includes(".term"))
    .map((m) => m[2] ?? "")
    .join("\n");
  expect(rule, "no rule whose selector list contains .term").not.toBe("");
  expect(rule).toContain("width: min(100%");
  expect(rule).toContain("margin-inline: auto");
});

test("the prompt controls give an unbreakable run somewhere to break", () => {
  // An option label is the agent's own line, verbatim. A TUI that draws its
  // options beside a preview panel puts that panel's box-drawing into the same
  // line, so a label can carry `────────────` with no space in it — and a run
  // with no break opportunity sets the grid item's min-content width, pushing
  // `.term` wider than the phone. Reported as "the layout crashes when the
  // options have a preview box".
  //
  // The pane already had this covered for every kind it renders (prose wraps,
  // structure scrolls, rule clips). These three are the controls BELOW it,
  // which had no such treatment.
  const css = readFileSync("src/web/styles.css", "utf8");
  const ruleFor = (sel: string) => {
    // Anchored at a line start. `indexOf(".term-structure {")` also matches
    // inside a grouped selector like `.term-pane, .term-structure {`, and if
    // such a group appears earlier in the file this reads THAT rule's body and
    // asserts against the wrong declarations — which is exactly what happened
    // when the pane and the strip briefly shared a scrollbar rule.
    const at = css.indexOf(`\n${sel} {`);
    expect(at, `no rule begins a line with \`${sel} {\``).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  for (const sel of [".term-option", ".term-selected", ".term-question"]) {
    expect(ruleFor(sel)).toContain("overflow-wrap: anywhere");
  }
});
