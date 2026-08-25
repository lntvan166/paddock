import { expect, test } from "bun:test";
import { qrLines } from "@server/tunnel/display";
import { qrMatrix, type QrMatrix } from "@server/qr";

/** A matrix from a picture: "#" dark, " " light. */
const from = (rows: string[]): QrMatrix => ({
  size: rows.length,
  isDark: (r, c) => rows[r]?.[c] === "#",
});

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// QUIET = 4 on every side, so a 2x2 matrix renders into a 10x10 field, which
// is 5 rows of half-blocks.
test("the quiet zone is four modules on every side", () => {
  const lines = qrLines(from(["##", "##"]), false);
  expect(lines).toHaveLength(5);
  expect(lines[0]).toHaveLength(10);
  // Rows 0-1 and 8-9 are quiet, so the first and last half-block rows are blank.
  expect(lines[0]).toBe(" ".repeat(10));
  expect(lines[4]).toBe(" ".repeat(10));
});

test("two vertical modules pack into one cell, and each combination has its glyph", () => {
  //  col0: dark over dark   -> full block
  //  col1: dark over light  -> upper half
  //  col2: light over dark  -> lower half
  //  col3: light over light -> space
  //
  // `size` is rows.length, so every row must be exactly 4 characters or the
  // columns asserted below are never read.
  const m = from([
    "##  ",
    "# # ",
    "    ",
    "    ",
  ]);
  // Padded field is 4+4+4 = 12 wide and 12 tall -> 6 half-block rows. The
  // matrix occupies padded rows 4..7 and columns 4..7; padded rows 4 and 5
  // pair into half-block row 2.
  const lines = qrLines(m, false);
  expect(lines).toHaveLength(6);
  expect(lines[2]!.slice(4, 8)).toBe("█▀▄ ");
});

// The numbers the layout thresholds are built on. If either moves, Task 4's
// 37-column and 26-row gates are wrong and the block will tear.
test("a real matrix is 19 rows of 37 columns", () => {
  const lines = qrLines(qrMatrix("https://quiet-harbor-8f31.trycloudflare.com/#4F7KQP2M"), false);
  expect(lines).toHaveLength(19);
  for (const l of lines) expect(l).toHaveLength(37);
});

// An odd-height padded field must pair its last row against a LIGHT row rather
// than reading off the end of the matrix.
test("an odd-height field pairs its last row against blank, not off the end", () => {
  // size 1 -> padded 9 -> 5 half-block rows, the last covering padded row 8
  // (quiet, light) paired against a row that does not exist.
  const lines = qrLines(from(["#"]), false);
  expect(lines).toHaveLength(5);
  expect(lines[4]).toBe(" ".repeat(9));
  // And the single dark module lands where the quiet zone puts it.
  expect(lines[2]!.charAt(4)).toBe("▀");
});

// Forced black-on-white, because QR means dark-on-light and a dark terminal
// renders the light modules dark — an inverted QR that not every scanner
// recovers from.
test("colour forces the polarity and nothing else", () => {
  const m = from(["##", "##"]);
  const plain = qrLines(m, false);
  const painted = qrLines(m, true);
  expect(painted.join("\n")).toMatch(/\x1b\[/);
  // Same glyphs; escapes are the only difference.
  expect(painted.map(strip)).toEqual(plain);
});
