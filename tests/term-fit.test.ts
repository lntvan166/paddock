import { expect, test } from "bun:test";
import { fitFontPx, MIN_FIT_COLUMNS, widestColumns } from "@web/term-fit";

/*
 * "Fit the terminal's width". Measured from a screenshot: a ~140-column
 * agent terminal in a wide browser left the pane's right third empty.
 */

test("the terminal's width is the widest line, colour stripped, one cell per code point", () => {
  expect(widestColumns(["\x1b[38;2;136;136;136m" + "─".repeat(140) + "\x1b[0m", "❯ sửa lỗi"])).toBe(140);
  expect(widestColumns([])).toBe(0);
});

test("140 columns across a 1400 px pane at 0.6 em a cell: about 16.6 px", () => {
  expect(fitFontPx({ avail: 1400, cols: 140, charEm: 0.6, base: 13.6, max: 24 })).toBe(16.6);
});

test("never smaller than the automatic size, so a phone is unchanged", () => {
  expect(fitFontPx({ avail: 360, cols: 140, charEm: 0.6, base: 12, max: 24 })).toBeNull();
});

test("never larger than the cap, and nothing at all for a screen too narrow to measure", () => {
  expect(fitFontPx({ avail: 3000, cols: 60, charEm: 0.6, base: 13, max: 24 })).toBe(24);
  expect(fitFontPx({ avail: 1400, cols: MIN_FIT_COLUMNS - 1, charEm: 0.6, base: 13, max: 24 })).toBeNull();
});
