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
    const at = css.indexOf(`${sel} {`);
    expect(at).toBeGreaterThan(-1);
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
