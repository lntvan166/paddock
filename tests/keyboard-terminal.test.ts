import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * The terminal screen has to account for the on-screen keyboard.
 *
 * REPORTED FROM A PHONE: opening an agent and focusing the reply field
 * immediately leaves the keyboard covering the field, while doing the same
 * thing slowly works. Both halves are explained by the same cause.
 *
 * `.term` is `position: fixed; inset: 0`, and on iOS the keyboard OVERLAYS the
 * layout viewport rather than shrinking it — so a fixed element stays glued to
 * a viewport that is now partly underneath the keyboard, and the reply row at
 * its foot goes with it. Nothing in the terminal ever accounted for that.
 *
 * When it appeared to work, that was Safari shifting the VISUAL viewport to
 * reveal the focused field — a heuristic, computed against the layout as it
 * stands at the moment of focus. Focus during mount, while the transcript is
 * still painting and the reply field is still sizing itself, and the reveal is
 * computed against a layout that then changes underneath it. Hence "slow works,
 * quick does not": the bug is not the speed, it is that correctness was resting
 * on a heuristic that only usually fires.
 *
 * `keyboard-inset.ts` already solved this for sheets, and its own comment
 * excluded the terminal on the grounds that the terminal's layout "must not
 * move when the keyboard opens". That reasoning is what changed: the layout
 * moving is not the cost, it is the fix — the transcript gets shorter while
 * you type, which is what every messaging app does and what the alternative
 * (typing blind) is plainly worse than.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The `.term` blocks, in file order. */
function termRules(): string[] {
  const out: string[] = [];
  // No leading delimiter: an earlier version anchored on `(^|})` and CONSUMED
  // the previous rule's closing brace, so two adjacent rules could never both
  // match and the very rule under test was invisible. A selector cannot contain
  // a brace, which is all the anchoring this needs.
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    // Only the shell itself, not `.term-pane`, `.term-reply`, and friends.
    if (/\.term\b(?![\w-])/.test(m[1]!)) out.push(`${m[1]!.trim()}{${m[2]!}}`);
  }
  return out;
}

test("the terminal shell lifts its foot above the keyboard", () => {
  const said = termRules().join("\n");
  expect(said, "the shell reads the inset the sheets already publish")
    .toContain("var(--kb-inset");
});

test("the lift comes AFTER the shared fixed rule, or it never applies", () => {
  // Learned the hard way one change earlier: a `.term-reply-field` block placed
  // BEFORE the shared rule it refined had its padding silently overridden, and
  // the field's text sat against the top edge. Same shape of mistake here would
  // be `inset: 0` winning over `bottom: var(--kb-inset)`.
  const shared = css.indexOf("position: fixed");
  const lift = css.indexOf("var(--kb-inset", shared);
  expect(shared, "the shared fixed rule is there").toBeGreaterThan(-1);
  expect(lift, "and the lift follows it").toBeGreaterThan(shared);
});

test("the inset is read with a 0px fallback everywhere it is used", () => {
  // Absence and zero have to mean the same thing: `useKeyboardInset` REMOVES
  // the property on cleanup rather than zeroing it.
  const uses = css.match(/var\(--kb-inset[^)]*\)/g) ?? [];
  expect(uses.length).toBeGreaterThan(0);
  for (const u of uses) expect(u, `${u} needs a fallback`).toContain("0px");
});
