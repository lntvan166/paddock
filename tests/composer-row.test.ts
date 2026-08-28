import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * The composer row's alignment, which only a browser can see and only a
 * stylesheet decides.
 *
 * The field GROWS — one row to five — while the attach and Send controls stay
 * 44px. Without an explicit alignment the row leaves them at its top, so a
 * four-line reply put both buttons 72px above the field's own bottom edge:
 * measured, after the textarea landed and before this rule existed. Telegram,
 * which is where the multi-line composer came from, keeps them on the bottom
 * edge and grows the box upward.
 *
 * Asserted as CSS text because happy-dom performs no layout, so no DOM test in
 * this suite can catch it — the same reason `keyboard-terminal.test.ts` reads
 * the stylesheet rather than a rendered box.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleFor(selector: string): string {
  // Selectors cannot contain braces, so no leading delimiter is needed — and
  // anchoring on one would consume the previous rule's closing brace and make
  // adjacent rules invisible.
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    if (m[1]!.trim() === selector) return m[2]!;
  }
  return "";
}

test("the composer keeps its controls on the bottom edge as the field grows", () => {
  expect(ruleFor(".term-reply")).toContain("align-items: flex-end");
});

test("the composer's bottom clearance collapses into the safe area", () => {
  // `.term` already pays `env(safe-area-inset-bottom)` for the whole shell, and
  // the row added a flat 0.5rem on top — so a phone with a home indicator paid
  // BOTH: ~34px of inset plus 8px, leaving a band under the composer that reads
  // as a mistake. Reported from a phone as "the space below text box send is
  // large".
  //
  // The 0.5rem is not wrong, it is conditional: its own comment says it exists
  // for a phone with NO home indicator, where the inset is 0 and the field
  // would otherwise sit flat against the glass. So it has to subtract what the
  // shell already provides rather than stack on it.
  const rule = ruleFor(".term-reply");
  expect(rule, "the row knows about the inset it sits inside").toContain(
    "env(safe-area-inset-bottom",
  );
  expect(rule, "and subtracts rather than adds").toMatch(/max\(/);
});
