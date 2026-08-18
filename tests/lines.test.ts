import { expect, test } from "bun:test";
import { classifyLine, groupLines } from "@web/lines";

// Fixtures reproduce the STRUCTURE observed in real panes with invented
// content, per the public-repo rule in CLAUDE.md.

test("box-drawing rules and boxed rows are structural", () => {
  for (const l of [
    "  ├─────────────────────────┼──────────────────────────────┼──",
    "  │         Feature         │             Item             │  ",
    "╭──────────────────────────────────────────────────────────╮",
    "╰──────────────────────────────────────────────────────────╯",
    "  └───────────────┴───────────────┘",
    "────────────────────────────────────────",
  ]) {
    expect(classifyLine(l)).toBe("structure");
  }
});

test("pipe tables with no box-drawing are structural", () => {
  expect(classifyLine("| api-refactor | queued  | 4m |")).toBe("structure");
  expect(classifyLine("|---|---|---|")).toBe("structure");
});

test("block elements — progress bars and meters — are structural", () => {
  // A progress bar must not reflow; half a bar on the next row is nonsense.
  expect(classifyLine("  model  ████████░░░░░░░░  42%")).toBe("structure");
  expect(classifyLine("  ▓▓▓▓▒▒▒▒░░░░")).toBe("structure");
});

test("prose is prose, including a single incidental pipe", () => {
  for (const l of [
    "Extracted the auth middleware and updated the runbook to match.",
    "Run `make check | tee out.log` before committing.",
    "  indented continuation of a sentence",
    "",
    "   ",
  ]) {
    expect(classifyLine(l)).toBe("prose");
  }
});

test("consecutive structural lines group into ONE run", () => {
  // The point of grouping: a table is one swipeable strip, not one strip per
  // rule and row. Ungrouped, the fixture below would produce five.
  const lines = [
    "Here is the summary table:",
    "┌────────────┬────────────┐",
    "│ Feature    │ Item       │",
    "├────────────┼────────────┤",
    "│ docs-clean │ pending    │",
    "└────────────┴────────────┘",
    "That is everything.",
  ];
  expect(groupLines(lines)).toEqual([
    { kind: "prose", from: 0, to: 0 },
    { kind: "structure", from: 1, to: 5 },
    { kind: "prose", from: 6, to: 6 },
  ]);
});

test("two tables separated by prose stay two runs", () => {
  const lines = ["│ a │", "", "│ b │"];
  expect(groupLines(lines)).toEqual([
    { kind: "structure", from: 0, to: 0 },
    { kind: "prose", from: 1, to: 1 },
    { kind: "structure", from: 2, to: 2 },
  ]);
});

test("runs at the very start and very end of the buffer are closed", () => {
  // An off-by-one here drops the last row of a table, which reads as data
  // loss rather than a layout bug.
  const lines = ["│ a │", "│ b │", "prose", "│ c │", "│ d │"];
  expect(groupLines(lines)).toEqual([
    { kind: "structure", from: 0, to: 1 },
    { kind: "prose", from: 2, to: 2 },
    { kind: "structure", from: 3, to: 4 },
  ]);
});

test("every line lands in exactly one block, in order", () => {
  // The invariant the renderer depends on: blocks tile the buffer with no
  // gaps and no overlaps, or lines silently vanish from the transcript.
  const lines = ["a", "│x│", "│y│", "", "b", "────", "c"];
  const blocks = groupLines(lines);
  const covered: number[] = [];
  for (const b of blocks) for (let i = b.from; i <= b.to; i++) covered.push(i);
  expect(covered).toEqual(lines.map((_, i) => i));
});

test("an empty buffer produces no blocks", () => {
  expect(groupLines([])).toEqual([]);
});

// ── decoration vs structure ────────────────────────────────────────────────
// A run of box characters with no text in it carries nothing in its columns:
// scrolling a line of dashes reveals more dashes. Giving each one a scroll
// strip put a fat scrollbar under every separator in the transcript — four
// visual rows where the terminal has two.

test("a standalone rule is decoration, not structure", () => {
  expect(groupLines(["prose", "─".repeat(208), "more prose"])).toEqual([
    { kind: "prose", from: 0, to: 0 },
    { kind: "rule", from: 1, to: 1 },
    { kind: "prose", from: 2, to: 2 },
  ]);
});

test("the agent's input box becomes two rules around a prompt, not two strips", () => {
  // Exactly the shape herdr sends for the input block.
  const lines = ["─".repeat(208), "❯", "─".repeat(208), "auto mode on"];
  expect(groupLines(lines).map((b) => b.kind)).toEqual(["rule", "prose", "rule", "prose"]);
});

test("a table keeps ONE strip, because its rules sit beside rows that have text", () => {
  const lines = [
    "┌────────────┬────────────┐",
    "│ Feature    │ Item       │",
    "├────────────┼────────────┤",
    "│ docs-clean │ pending    │",
    "└────────────┴────────────┘",
  ];
  expect(groupLines(lines)).toEqual([{ kind: "structure", from: 0, to: 4 }]);
});

test("a bar with a label scrolls; a bare bar does not", () => {
  expect(groupLines(["  model ████░░░░ 42%"])).toEqual([{ kind: "structure", from: 0, to: 0 }]);
  expect(groupLines(["  ████░░░░"])).toEqual([{ kind: "rule", from: 0, to: 0 }]);
});

test("consecutive rules with nothing between them stay ONE decorative run", () => {
  expect(groupLines(["────", "════", "────"])).toEqual([{ kind: "rule", from: 0, to: 2 }]);
});

test("rule blocks still tile the buffer with prose and structure", () => {
  const lines = ["a", "────", "│ x │", "b"];
  const blocks = groupLines(lines);
  const covered: number[] = [];
  for (const b of blocks) for (let i = b.from; i <= b.to; i++) covered.push(i);
  expect(covered).toEqual([0, 1, 2, 3]);
});

// ── separators never join their neighbours ─────────────────────────────────
// A plain separator is one box character repeated. A TABLE rule is not: it
// carries junctions (├ ┼ ┤ ┬ ┴) whose positions mark the columns, so it must
// stay welded to the rows it belongs to. Separating the two lets the input
// box's rules stand alone (and therefore stay clipped) without splitting any
// table.

test("a plain separator does not merge into an adjacent structural run", () => {
  // The exact tail herdr sends: separator, prompt, separator, then a labelled
  // progress bar. The second separator used to be swallowed by the bar's run,
  // which gave the input box a scrollbar on one side and not the other.
  const lines = ["─".repeat(208), "❯", "─".repeat(208), "  Opus  ████░░░░ 32%"];
  expect(groupLines(lines).map((b) => b.kind)).toEqual(["rule", "prose", "rule", "structure"]);
});

test("a table rule has junctions, so it stays welded to its rows", () => {
  const lines = ["├────┼────┤", "│ a  │ b  │", "├────┼────┤"];
  expect(groupLines(lines)).toEqual([{ kind: "structure", from: 0, to: 2 }]);
});

test("a separator run is still one block, whatever characters it uses", () => {
  expect(groupLines(["────", "════", "━━━━"])).toEqual([{ kind: "rule", from: 0, to: 2 }]);
});
