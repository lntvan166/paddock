/**
 * "Fit the terminal's width": the font size at which a terminal's columns fill
 * the pane. Pure, so the arithmetic is tested without a layout engine.
 *
 * The terminal is as wide as wherever it was last shown at the desk; paddock
 * only observes it. Its width is read off the screen: the widest line seen,
 * which for Claude Code is its full-width `─` rules, exactly the column count.
 */

const ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Cells in the widest line, ANSI stripped, one cell per code point. */
export function widestColumns(lines: readonly string[]): number {
  let widest = 0;
  for (const line of lines) {
    const n = Array.from(line.replace(ESCAPE, "")).length;
    if (n > widest) widest = n;
  }
  return widest;
}

/** Below this many columns the screen is no measure of the terminal's width. */
export const MIN_FIT_COLUMNS = 40;

/**
 * The size, in px, that puts `cols` cells across `avail` px, given one cell's
 * width as a fraction of the font size (`charEm`). Never below `base` (the
 * automatic size, so a phone is unchanged) and never above `max`, so a shell
 * that printed three short lines is not blown up to fill the screen. Null
 * when there is nothing to fit: then the automatic size applies.
 */
export function fitFontPx(o: { avail: number; cols: number; charEm: number; base: number; max: number }): number | null {
  if (o.cols < MIN_FIT_COLUMNS || o.avail <= 0 || o.charEm <= 0) return null;
  const px = Math.floor((o.avail / (o.cols * o.charEm)) * 10) / 10;
  if (px <= o.base) return null;
  return Math.min(px, o.max);
}
