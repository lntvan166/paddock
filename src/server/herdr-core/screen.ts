import { Terminal, type IBufferCell } from "@xterm/headless";

/**
 * An app agent's screen, with its colours.
 *
 * herdr-core's `terminal.read` returns text only, so app agents rendered as
 * one grey wall, where terminal herdr's `format: "ansi"` read keeps the
 * colours a TUI uses as structure (diff markers, the selected option, boxed
 * labels). The core's first paint to an OBSERVER (`terminal.attach` with
 * `observe: true`, which never types or resizes) does carry them, as a VT
 * redraw: cursor moves, mode resets, then the cells. This replays that redraw
 * in a headless terminal and reads the cells back as lines in the SGR subset
 * `web/ansi.ts` parses, so the browser renders both backends the same way.
 *
 * Measured on a throwaway terminal (2026-11-10): the paint opens with a soft
 * reset and a clear, sets tab stops, and draws every cell with 256-colour or
 * truecolor SGR; `history` lines of scrollback come first.
 */

const SGR_RESET = "\x1b[0m";

type Cell = IBufferCell;

function colour(cell: Cell, fg: boolean): string | null {
  const isRGB = fg ? cell.isFgRGB() : cell.isBgRGB();
  const isPalette = fg ? cell.isFgPalette() : cell.isBgPalette();
  const c = fg ? cell.getFgColor() : cell.getBgColor();
  const base = fg ? 38 : 48;
  if (isRGB) return `${base};2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`;
  if (isPalette) return `${base};5;${c}`;
  return null;
}

/** The SGR parameters for a cell, "" for the default style. */
function styleOf(cell: Cell): string {
  const p: string[] = [];
  if (cell.isBold()) p.push("1");
  if (cell.isDim()) p.push("2");
  if (cell.isItalic()) p.push("3");
  if (cell.isUnderline()) p.push("4");
  if (cell.isInverse()) p.push("7");
  const fg = colour(cell, true);
  if (fg) p.push(fg);
  const bg = colour(cell, false);
  if (bg) p.push(bg);
  return p.join(";");
}

/** A blank cell that would show nothing: no glyph and no background. */
function invisible(cell: Cell): boolean {
  const ch = cell.getChars();
  return (ch === "" || ch === " ") && !cell.isBgRGB() && !cell.isBgPalette() && !cell.isInverse();
}

function lineAt(term: Terminal, y: number, cell: Cell): string {
  const line = term.buffer.active.getLine(y);
  if (!line) return "";
  // Trailing blanks are the terminal's width, not content.
  let end = term.cols - 1;
  while (end >= 0 && line.getCell(end, cell) && invisible(cell)) end--;
  let out = "";
  let current = "";
  for (let x = 0; x <= end; x++) {
    if (!line.getCell(x, cell)) break;
    const w = cell.getWidth();
    if (w === 0) continue; // the second half of a wide character
    const style = styleOf(cell);
    if (style !== current) {
      out += style === "" ? SGR_RESET : `${SGR_RESET}\x1b[${style}m`;
      current = style;
    }
    out += cell.getChars() || " ";
  }
  if (current !== "") out += SGR_RESET;
  return out;
}

/**
 * Replay a first paint and return its lines, oldest scrollback first, with no
 * trailing empty rows. `history` is how many scrollback lines the paint was
 * asked to carry.
 */
export async function paintToLines(paint: Uint8Array, cols: number, rows: number, history = 0): Promise<string[]> {
  const term = new Terminal({ cols, rows, scrollback: Math.max(history, 0), allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(paint, resolve));
    const cell = term.buffer.active.getNullCell();
    const lines: string[] = [];
    for (let y = 0; y < term.buffer.active.length; y++) lines.push(lineAt(term, y, cell));
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  } finally {
    term.dispose();
  }
}
