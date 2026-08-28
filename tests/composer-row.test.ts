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
