import { expect, test } from "bun:test";
import { claudeInputVisible, readClaudeDraft, sameDraft } from "@shared/draft";

/*
 * Claude Code's input box, read off the ANSI screen. Every fixture line below
 * is a line captured from a live Claude Code through herdr-core during the
 * probe recorded in docs/gotchas.md; only the draft words are invented.
 */

const RULE = "─".repeat(60);
const FOOT = ["  Opus 5.5  --", "  ⏵⏵ auto mode on (shift+tab to cycle)"];
const box = (...lines: string[]) => ["● earlier transcript", "", RULE, ...lines, RULE, ...FOOT];

/** What Claude Code draws after `❯`: a NO-BREAK space, measured. */
const M = "❯\u00a0";
const SUGGESTION = M + '\u001b[0m\u001b[2mTry "write a test for <filepath>"\u001b[0m';

test("an empty box shows a dim suggestion, and reads as empty, not as a draft", () => {
  expect(readClaudeDraft(box(SUGGESTION))).toEqual({ kind: "empty" });
  // The whole point of reading ANSI: the same line as plain text looks typed.
  expect(readClaudeDraft(box(M + 'Try "write a test for <filepath>"'))).toEqual({
    kind: "text", text: 'Try "write a test for <filepath>"',
  });
});

test("a typed draft has no SGR and reads as text, Vietnamese included", () => {
  expect(readClaudeDraft(box(M + "sửa lỗi auth giúp mình"))).toEqual({ kind: "text", text: "sửa lỗi auth giúp mình" });
});

test("a multi-line draft joins its lines; a continuation is indented by two", () => {
  expect(readClaudeDraft(box(M + "dòng một", "  dòng hai"))).toEqual({ kind: "text", text: "dòng một\ndòng hai" });
  // An empty line inside the draft is kept; trailing empty lines are not.
  expect(readClaudeDraft(box(M + "một", "", "  ba", ""))).toEqual({ kind: "text", text: "một\n\nba" });
});

test("a collapsed paste or an image is refused: its content is not on screen", () => {
  expect(readClaudeDraft(box(M + "xem cái này [Pasted text #1 +11 lines]"))).toEqual({ kind: "unknown" });
  expect(readClaudeDraft(box(M + "[Image #1] what is this"))).toEqual({ kind: "unknown" });
});

test("anything outside the measured shape is unknown, never a guess", () => {
  // Colour other than dim (a mode, a highlight): not measured.
  expect(readClaudeDraft(box(M + "\u001b[38;2;177;185;249mhi\u001b[0m"))).toEqual({ kind: "unknown" });
  // Dim beside typed text.
  expect(readClaudeDraft(box(M + "typed \u001b[2mghost\u001b[0m"))).toEqual({ kind: "unknown" });
  // A dialog's `❯ 1. Yes` is not under a rule.
  expect(readClaudeDraft(["Do you want to proceed?", "❯ 1. Yes", "  2. No"])).toEqual({ kind: "unknown" });
  // No closing rule.
  expect(readClaudeDraft(["", RULE, "❯ half"])).toEqual({ kind: "unknown" });
  // A continuation that is not indented.
  expect(readClaudeDraft(box(M + "one", "two"))).toEqual({ kind: "unknown" });
  // A bash-mode box (`!`) is not the input this reads.
  expect(readClaudeDraft(box("! ls"))).toEqual({ kind: "unknown" });
});

test("the bottom-most box is the input; a box higher up is transcript", () => {
  const screen = ["", RULE, "❯ old quoted prompt", RULE, "● reply", ...box(SUGGESTION)];
  expect(readClaudeDraft(screen)).toEqual({ kind: "empty" });
});

test("an ordinary space after the mark is accepted too", () => {
  expect(readClaudeDraft(box("❯ plain space"))).toEqual({ kind: "text", text: "plain space" });
});

test("two reads of one draft agree despite what a screen cannot show", () => {
  expect(sameDraft("abc  ", "abc")).toBe(true);
  expect(sameDraft("a\nb\n\n", "a\nb")).toBe(true);
  expect(sameDraft("a b", "ab")).toBe(false);
});

// A `/btw` answer, as captured: it REPLACES the input box (its top edge is
// `▔`, not a rule), and its footer lists single-letter keys.
const BTW = [
  "● earlier transcript", "", RULE, M + "earlier quoted prompt", RULE, "● reply",
  "▔".repeat(60),
  "  /btw trả lời đúng một chữ: ok",
  "    ok",
  "  ⇧←/→ to browse · c to copy · f to fork · x to clear history · Esc to close",
];

test("the input box is visible on an ordinary screen, and not while a /btw answer covers it", () => {
  expect(claudeInputVisible(box(SUGGESTION))).toBe(true);
  expect(claudeInputVisible(box(M + "a draft"))).toBe(true);
  expect(claudeInputVisible(BTW)).toBe(false);
  expect(readClaudeDraft(BTW)).toEqual({ kind: "unknown" });
});
