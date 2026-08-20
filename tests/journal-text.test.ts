import { expect, test } from "bun:test";
import {
  clamp, MAX_TEXT_CHARS, stripAnsi, stripMenu, summariseTool, toLines,
} from "@server/journal/text";

test("ansi escapes are removed", () => {
  expect(stripAnsi("[1;36mhello[0m")).toBe("hello");
});

test("a cursor marker is stripped from journal text", () => {
  // THE hazard. A journal turn can carry an ALREADY ANSWERED menu, and blended
  // straight above the live screen it reads as the question being asked now.
  // `prompt-parse.ts` records this exact failure. Only the live screen may
  // render a selectable menu.
  expect(stripMenu("❯ 1. Yes")).toBe("");
  expect(stripMenu("  ❯ 2. No, keep it")).toBe("");
});

test("a numbered option row is stripped even without a cursor", () => {
  expect(stripMenu("  2. No")).toBe("");
  expect(stripMenu("1. Approve this change")).toBe("");
});

test("a real multi-line menu is stripped down to its question", () => {
  // THE decisive case. A real prompt is a question plus two or more option
  // lines, not one bare option line on its own — an anchored ^...$ match
  // against the WHOLE turn text only ever fires on the single-line toy case.
  expect(
    stripMenu("Do you want to proceed?\n❯ 1. Yes\n  2. No, tell it what to do differently"),
  ).toBe("Do you want to proceed?");
});

test("an ASCII > cursor is treated like ❯", () => {
  expect(stripMenu("> 1. Yes")).toBe("");
});

test("a ) separator is accepted alongside .", () => {
  expect(stripMenu("2) No")).toBe("");
});

test("an option row survives no matter how long its label is", () => {
  // Length must not decide whether a row is an option: a long real option is
  // still an option.
  expect(
    stripMenu("❯ 1. Yes, and also run the full regression suite before merging"),
  ).toBe("");
});

test("a cursor sitting on ordinary prose is kept, not stripped", () => {
  // A cursor glyph quoting a shell prompt is not the hazard this guards —
  // deleting it would silently eat real content, the worse failure.
  expect(stripMenu("❯ npm install")).toBe("❯ npm install");
});

test("a lettered option is stripped only when a cursor marks it", () => {
  expect(stripMenu("❯ a. Yes")).toBe("");
  expect(stripMenu("a. done")).toBe("a. done");
});

test("ordinary prose that merely starts with a number survives", () => {
  // Over-stripping would silently eat real content, which is worse than the
  // hazard it guards: "2. " here is prose the agent wrote, not an option row.
  expect(stripMenu("2026 was the year")).toBe("2026 was the year");
  expect(stripMenu("I found 3 failures")).toBe("I found 3 failures");
});

test("a tool call becomes a name and a short hint, never its output", () => {
  expect(summariseTool("Bash", { command: "bun test", description: "run tests" }))
    .toBe("Bash · run tests");
  expect(summariseTool("Read", { file_path: "/srv/project/src/timer.ts" }))
    .toBe("Read · timer.ts");
  expect(summariseTool("Write", {})).toBe("Write");
});

test("a tool hint never carries a whole command line", () => {
  // The hint is orientation, not a transcript. An unbounded command would put
  // arbitrary shell text — and anything interpolated into it — on the wire.
  const long = "x".repeat(500);
  expect(summariseTool("Bash", { description: long }).length).toBeLessThanOrEqual(80);
});

test("clamp truncates to AT MOST max characters, ellipsis included", () => {
  // The ellipsis counts. A clamp that returns max+1 makes every caller's cap
  // a lie by one character, which is how `summariseTool` would exceed its own.
  expect(clamp("abcdef", 3)).toBe("ab…");
  expect(clamp("abcdef", 3).length).toBe(3);
  expect(clamp("abc", 10)).toBe("abc");
});

test("toLines renders a turn with a speaker and folds its tools", () => {
  const lines = toLines([
    { role: "user", at: "2026-08-20T13:04:00Z", text: "fix the flaky test", tools: [] },
    { role: "assistant", at: "2026-08-20T13:05:00Z", text: "Found it: the timer resets.", tools: ["Bash ×3", "Read timer.ts"] },
  ]);
  expect(lines).toEqual([
    "you · 13:04",
    "fix the flaky test",
    "",
    "agent · 13:05",
    "▸ Bash ×3 · Read timer.ts",
    "Found it: the timer resets.",
    "",
  ]);
});

test("toLines drops a turn left empty by stripping", () => {
  // A turn that was only a menu must not leave a bare speaker line behind.
  expect(toLines([{ role: "assistant", at: null, text: "", tools: [] }])).toEqual([]);
});

test("the text cap is bounded", () => {
  expect(MAX_TEXT_CHARS).toBe(4_000);
});
