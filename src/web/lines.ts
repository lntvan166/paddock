/**
 * Splitting a terminal buffer into what may reflow and what may not.
 *
 * Terminal output mixes two kinds of line with opposite needs. Prose is
 * sentences that read badly when you have to scroll sideways for every one of
 * them. Structure — tables, box rules, progress bars — carries meaning in
 * COLUMN POSITION, and folding it to the viewport destroys that meaning while
 * still looking approximately like a table, which is the worst outcome
 * because it is not obviously broken.
 *
 * Measured on one real pane of 63 lines: 18 box rules, 15 boxed rows, 18
 * prose, 12 blank. Neither "wrap everything" nor "wrap nothing" is right when
 * the split is that even.
 *
 * This module is pure and knows nothing about React, ANSI, or the DOM. It is
 * the piece most likely to need tuning as agent TUIs change, and keeping it
 * free of I/O means that tuning is a change to one file with tests.
 */

export type LineKind = "prose" | "structure";

/** A maximal run of consecutive lines of one kind. `from`/`to` are inclusive. */
export interface Block {
  kind: LineKind;
  from: number;
  to: number;
}

/**
 * U+2500–U+257F Box Drawing plus U+2580–U+259F Block Elements.
 *
 * Block Elements are included deliberately: progress bars and meters are drawn
 * with `█▓▒░`, and half a progress bar continued on the next row is nonsense.
 */
const BOX_OR_BLOCK = /[─-▟]/;

/**
 * TWO pipes, not one. A single pipe is overwhelmingly a shell pipeline inside
 * a sentence (`make check | tee out.log`), and treating that as a table would
 * make an ordinary line of prose unwrappable.
 */
function pipeCount(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === "|" || ch === "│") n++;
  return n;
}

export function classifyLine(text: string): LineKind {
  // A blank line is spacing, not structure. Grouping it as structure would
  // weld two unrelated tables into one strip.
  if (text.trim() === "") return "prose";
  if (BOX_OR_BLOCK.test(text)) return "structure";
  if (pipeCount(text) >= 2) return "structure";
  return "prose";
}

/**
 * Group consecutive lines of the same kind into maximal runs.
 *
 * Grouping is the whole point rather than an optimisation: a table is rules
 * AND rows interleaved, so classifying line by line without grouping would
 * render a six-line table as six independent scroll strips — noisier than the
 * folding it set out to fix.
 *
 * The returned blocks TILE the input: every index appears in exactly one
 * block, in order, with no gaps. The renderer slices its span array by these
 * bounds, so a gap here silently drops lines from the transcript.
 */
export function groupLines(texts: string[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < texts.length; i++) {
    const kind = classifyLine(texts[i]!);
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) last.to = i;
    else blocks.push({ kind, from: i, to: i });
  }
  return blocks;
}
