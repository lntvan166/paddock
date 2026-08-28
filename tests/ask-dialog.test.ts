import { expect, test } from "bun:test";
import { parseAskDialog } from "@server/herdr/ask-dialog";

/**
 * Real captures, reduced to the dialog region.
 *
 * Taken from a live `claude` agent one key at a time — see the design doc,
 * `docs/design/2026-08-28-question-dialog-design.md`. Invented content
 * throughout, per this repo's public-repo rules.
 */

/** Two questions, both multi-select, nothing answered yet. */
const TWO_MULTI = [
  "←  ☐ Tea  ☐ Coffee  ✔ Submit  →",
  "",
  "Which teas do you drink?",
  "",
  "❯ 1. [ ] Green tea",
  "  Light and grassy, lower caffeine.",
  "  2. [ ] Black tea",
  "  Strong and malty, takes milk well.",
  "  3. [ ] Type something",
  "     Next",
  "──────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

/** Single-select. Note: NO advance row — picking an option advances by itself. */
const SINGLE = [
  "←  ☒ Colours  ☒ Fruit  ✔ Submit  →",
  "",
  "Which is your single favourite fruit?",
  "",
  "❯ 1. Mango",
  "     Sweet, tropical, and unmistakable.",
  "  2. Apple ✔",
  "     Crisp, reliable, available year-round.",
  "  3. Strawberry",
  "     Bright and tart-sweet, best in season.",
  "  4. Type something.",
  "──────────────────────────────",
  "  5. Chat about this",
].join("\n");

/** After typing: the free-text label IS the text now. */
const TYPED = [
  "←  ☐ Vegetables  ✔ Submit  →",
  "",
  "Which vegetables do you like most?",
  "",
  "  1. [ ] Broccoli",
  "  Green, crunchy, good roasted or steamed.",
  "  2. [ ] Carrot",
  "  Sweet and versatile, raw or cooked.",
  "  3. [ ] Spinach",
  "  Leafy and mild, wilts into almost anything.",
  "❯ 4. [✔] okra",
  "     Submit",
  "──────────────────────────────",
  "  5. Chat about this",
].join("\n");

const ESC = String.fromCharCode(27);

/**
 * The tab bar as it really arrives, from a `--ansi` read of the `visible`
 * source. The current tab is the ONLY segment wrapped in a background-setting
 * SGR (`48;2;…`); the truecolor FOREGROUND on `←` is the decoy that a naive
 * "contains 4x" test trips over.
 */
const ANSI_BAR = [
  `${ESC}[0m${ESC}[38;2;153;153;153m← ${ESC}[0m${ESC}[38;2;0;0;0m${ESC}[48;2;177;185;249m ☐ Tea ${ESC}[0m ☐ Coffee  ✔ Submit  →`,
  "",
  "Which teas do you drink?",
  "",
  "❯ 1. [ ] Green tea",
  "  Light and grassy, lower caffeine.",
  "  2. [ ] Black tea",
  "  Strong and malty, takes milk well.",
].join("\n");

test("a two-question multi-select dialog parses whole", () => {
  const d = parseAskDialog(TWO_MULTI);

  expect(d).not.toBeNull();
  expect(d!.question).toBe("Which teas do you drink?");
  expect(d!.mode).toBe("multi");
  expect(d!.advance).toBe("Next");
  expect(d!.cursor).toEqual({ kind: "option", key: "1" });
  expect(d!.questions.map((q) => [q.label, q.answered, q.isSubmit])).toEqual([
    ["Tea", false, false],
    ["Coffee", false, false],
    ["Submit", false, true],
  ]);
  expect(d!.options.map((o) => [o.key, o.label, o.checked, o.freeText])).toEqual([
    ["1", "Green tea", false, false],
    ["2", "Black tea", false, false],
    ["3", "Type something", false, true],
  ]);
  // The description belongs to the option above it, and the free-text row has
  // none — which is half of how it is identified once its label changes.
  expect(d!.options[0]!.detail).toBe("Light and grassy, lower caffeine.");
  expect(d!.options[2]!.detail).toBeUndefined();
});

test("`Chat about this` below the rule is not an option", () => {
  // It is an escape into free prose, which the reply box already covers.
  // Modelling it as an option would put a button on screen that abandons the
  // question instead of answering it.
  const d = parseAskDialog(TWO_MULTI);
  expect(d!.options.some((o) => o.label.includes("Chat about"))).toBe(false);
});

test("a single-select dialog is recognised as one, ticks and all", () => {
  const d = parseAskDialog(SINGLE);

  expect(d!.mode).toBe("single");
  // No advance row exists in this mode. Anchoring the free-text rule on one
  // would have failed here — the mode where getting it wrong is worst.
  expect(d!.advance).toBeNull();
  expect(d!.options.map((o) => [o.label, o.picked])).toEqual([
    ["Mango", false],
    ["Apple", true],
    ["Strawberry", false],
    ["Type something.", false],
  ]);
  expect(d!.options[3]!.freeText, "spelled with a full stop in this mode").toBe(true);
  expect(d!.options.every((o) => o.checked === undefined)).toBe(true);
  expect(d!.questions[0]!.answered, "☒ means answered").toBe(true);
});

test("the free-text row is still found after the operator has typed into it", () => {
  // THE case a label rule cannot survive: the label now reads `okra`. Falling
  // back to "last option, and the only one with no description" is what keeps
  // the text field a text field instead of turning it into a button.
  const d = parseAskDialog(TYPED);

  expect(d!.options[3]!.label).toBe("okra");
  expect(d!.options[3]!.freeText).toBe(true);
  expect(d!.options[3]!.checked, "typing ticks it automatically").toBe(true);
  expect(d!.options.slice(0, 3).every((o) => !o.freeText)).toBe(true);
  expect(d!.cursor).toEqual({ kind: "option", key: "4" });
});

test("the current tab comes from a background colour, not from a guess", () => {
  const d = parseAskDialog(ANSI_BAR);

  expect(d!.questions.map((q) => q.current)).toEqual([true, false, false]);
});

test("a read with no colour reports no current tab rather than inventing one", () => {
  // The `detection` source strips every escape, so this is what a caller that
  // reads the wrong source gets. Saying "unknown" is honest; picking the first
  // tab would put the marker on the wrong question.
  const d = parseAskDialog(TWO_MULTI);
  expect(d!.questions.every((q) => !q.current)).toBe(true);
});

test("the review screen parses as the two-option prompt it is", () => {
  const review = [
    "←  ☒ Vegetables  ✔ Submit  →",
    "",
    "Review your answers",
    "",
    " ● Which vegetables do you like most?",
    "   → okra",
    "",
    "Ready to submit your answers?",
    "",
    "❯ 1. Submit answers",
    "  2. Cancel",
  ].join("\n");

  const d = parseAskDialog(review);

  // The QUESTION is the last line before the options, not the first line of the
  // screen: "Review your answers" is a heading and the summary sits under it.
  expect(d!.question).toBe("Ready to submit your answers?");
  expect(d!.mode).toBe("single");
  expect(d!.options.map((o) => o.label)).toEqual(["Submit answers", "Cancel"]);
  expect(d!.options.some((o) => o.freeText), "neither row takes text").toBe(false);
});

test("every shape it does not fully recognise is refused", () => {
  const cases: [string, string][] = [
    ["no tab bar", "Do you want to proceed?\n❯ 1. Yes\n  2. No"],
    ["one option", "←  ☐ A  ✔ Submit  →\n\nQ?\n\n❯ 1. [ ] Only"],
    ["numbering not contiguous from 1", "←  ☐ A  ✔ Submit  →\n\nQ?\n\n❯ 2. [ ] B\n  3. [ ] C"],
    ["checkboxes on some rows only", "←  ☐ A  ✔ Submit  →\n\nQ?\n\n❯ 1. [ ] B\n  2. Plain"],
    ["an unrecognised tab marker", "←  ▣ A  ✔ Submit  →\n\nQ?\n\n❯ 1. [ ] B\n  2. [ ] C"],
  ];

  for (const [why, screen] of cases) {
    expect(parseAskDialog(screen), why).toBeNull();
  }
});

test("the LAST tab bar on screen wins", () => {
  // A resolved dialog's bar can still be in the scrollback above the live one.
  const stale = [
    "←  ☒ Old  ✔ Submit  →",
    "",
    "An answered question?",
    "",
    "  1. [✔] Chosen",
    "  Description.",
    "  2. [ ] Other",
    "  Description.",
    "",
    TWO_MULTI,
  ].join("\n");

  expect(parseAskDialog(stale)!.question).toBe("Which teas do you drink?");
});

test("the advance row is still found when the CURSOR is on it", () => {
  // A one-character bug, found in a browser and not by any of the tests above,
  // because those fixtures invented the indentation. On the real screen the
  // cursor marker sits at COLUMN 0 on this row — `❯    Next`, exactly as it
  // does on an option row — and a regex demanding leading whitespace made the
  // row invisible precisely when the cursor had reached it. Which is when
  // advancing needs to see it: `advance` came back null, the route refused, and
  // the Next button did nothing.
  const onNext = [
    "←  ☐ Tea  ✔ Submit  →",
    "",
    "Which teas do you drink?",
    "",
    "  1. [ ] Green tea",
    "  Light and grassy, lower caffeine.",
    "  2. [ ] Type something",
    "❯    Next",
  ].join("\n");

  const d = parseAskDialog(onNext);

  expect(d!.advance).toBe("Next");
  expect(d!.cursor).toEqual({ kind: "advance" });
});

test("an unindented word is not mistaken for the advance row", () => {
  // The `\s+` after the optional cursor is what keeps this true: a description
  // line that happens to read `Next` is prose, not a button.
  const prose = [
    "←  ☐ Tea  ✔ Submit  →",
    "",
    "Which teas do you drink?",
    "",
    "  1. [ ] Green tea",
    "Next",
    "  2. [ ] Black tea",
    "  Strong and malty.",
  ].join("\n");

  expect(parseAskDialog(prose)!.advance).toBeNull();
});

test("the free-text row reports what has been typed into it", () => {
  // The typed text replaces the label, so only this tells the two apart — and
  // both the field's placeholder and the erase-before-write need to know.
  const fresh = parseAskDialog(TWO_MULTI)!.options[2]!;
  expect(fresh.freeText).toBe(true);
  expect(fresh.typed, "untouched: still the prompt's own words").toBeUndefined();

  const used = parseAskDialog(TYPED)!.options[3]!;
  expect(used.freeText).toBe(true);
  expect(used.typed).toBe("okra");
});
