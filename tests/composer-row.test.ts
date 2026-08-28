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
  // EVERY rule that targets this selector, concatenated — not the first exact
  // match. A declaration can live in a grouped rule (`.a, .b { … }`) while a
  // later rule adds one property of its own, and matching exactly finds only
  // the second: that is how an assertion for `position` read a rule containing
  // nothing but `top` and failed on a stylesheet that was correct.
  //
  // Matched as a whole ITEM of the comma list, never as a substring, so
  // `.term-reply` does not pick up `.term-reply .term-attach`.
  //
  // Selectors cannot contain braces, so no leading delimiter is needed — and
  // anchoring on one would consume the previous rule's closing brace and make
  // adjacent rules invisible.
  const re = /([^{}]+)\{([^}]*)\}/g;
  let out = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const targets = m[1]!.split(",").map((t) => t.trim());
    if (targets.includes(selector)) out += `${m[2]!}\n`;
  }
  return out;
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

test("neither transcript control sits in the layout, so neither shifts it", () => {
  // MEASURED before this rule: scrolling up made both `term-earlier` and
  // `term-to-bottom` appear as in-flow 44px bands, the pane lost 88px and its
  // top moved down 44 — the transcript jumped while the operator was reading
  // it. Reported as "output has moved up", and it is the same class of problem
  // as the composer pushing the tail out of view.
  //
  // They overlay the pane instead. Asserted as CSS text because happy-dom
  // performs no layout, which is exactly how this shipped.
  for (const selector of [".term-earlier", ".term-to-bottom"]) {
    const rule = ruleFor(selector);
    expect(rule, `${selector} floats over the pane`).toContain("position: absolute");
  }
  // And the thing they are positioned against has to establish the containing
  // block, or `absolute` resolves against the fixed shell and lands anywhere.
  expect(ruleFor(".term-pane-wrap")).toContain("position: relative");
});

test("neither transcript control sits on top of a line the operator is reading", () => {
  // MEASURED on a phone screenshot: the Latest pill, centred, sat in the middle
  // of the last visible line — `Bash · Stop the demo i[↓ Latest]firm 8787 still
  // up`. A control floating over a scroller covers something by construction,
  // so each end gets the best fix available to it.
  //
  // The top has a real one: `scrollTop` is already 0 when that pill shows, so
  // there is nowhere to scroll to escape it, and the pane reserves the space
  // instead. Asserted with the `on` state in the selector, because a rule that
  // padded unconditionally would leave dead space on every pane.
  expect(ruleFor('.term-pane[data-pill-top="on"]')).toContain("padding-top");

  // The bottom cannot: that control only exists while there is more content
  // below it. What it can stop doing is sitting mid-sentence.
  const latest = ruleFor(".term-to-bottom");
  expect(latest, "out of the centre").toContain("left: auto");
  expect(latest, "and into the corner").toContain("right:");
});
