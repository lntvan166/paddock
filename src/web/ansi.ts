/**
 * SGR (Select Graphic Rendition) parsing, written from ECMA-48 §8.3.117.
 *
 * Colour in agent output is not decoration — it IS the document structure.
 * Headings, diff markers, the boxed labels a TUI draws, the highlight on the
 * currently selected option: strip the escapes and all of that collapses into
 * one undifferentiated grey wall, which is what paddock rendered for the whole
 * of v2 (`strip_ansi: true`).
 *
 * Measured against herdr 0.8.0: the agent output actually on the wire uses
 * truecolor (`38;2;r;g;b`) almost exclusively, plus `1` and `3`. The indexed
 * and 256-colour branches below are for other TUIs, not for this one — they
 * are cheap and their absence would be a silent mis-render rather than an
 * error.
 *
 * Output is DATA, never markup: the caller renders each span's `text` as a
 * React child, so it is escaped by React. Nothing here produces HTML, and
 * nothing here may ever be handed to `innerHTML` — agent output is arbitrary
 * untrusted text that happens to be on its way to a screen.
 */

export interface AnsiSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/**
 * Matches, in order: an SGR sequence (captured), any other CSI sequence, an
 * OSC string, and a two-byte charset selector. Only the first is interpreted;
 * the rest are recognised solely so they can be DROPPED rather than printed as
 * mojibake — a cursor-movement sequence rendered literally is worse than no
 * colour at all.
 */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b./g;

/** The 16 ANSI colours, for the indexed and 256-colour branches. */
const BASE16 = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

/** xterm 256: 0-15 palette, 16-231 a 6×6×6 cube, 232-255 a greyscale ramp. */
function xterm256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(i / 36) % 6)},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

interface State {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
}

/**
 * `fg` and `bg` are listed explicitly as `undefined` rather than omitted.
 *
 * Reset (`SGR 0`) is applied with `Object.assign(state, fresh())`, which only
 * overwrites keys the source object HAS — so omitting them here made reset
 * clear every attribute except the two that matter most, and a colour opened
 * once would bleed down the rest of the pane.
 */
const fresh = (): State => ({
  fg: undefined,
  bg: undefined,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  reverse: false,
});

/**
 * Applies one SGR sequence's parameters to the running state.
 *
 * Parameters are consumed with an index rather than a `for…of`, because the
 * extended-colour forms (`38;5;n` and `38;2;r;g;b`) swallow the parameters
 * that follow them. Treating those as independent codes is the classic bug:
 * `38;2;255;0;0` would otherwise also be read as "underline" (4 is absent
 * here, but `38;5;4` would set blue AND consume nothing), painting colours
 * that were never requested.
 */
function applySgr(params: number[], state: State): void {
  // A bare `\x1b[m` means `\x1b[0m`.
  if (params.length === 0) params = [0];

  for (let i = 0; i < params.length; i++) {
    const code = params[i]!;
    switch (code) {
      case 0: Object.assign(state, fresh()); break;
      case 1: state.bold = true; break;
      case 2: state.dim = true; break;
      case 3: state.italic = true; break;
      case 4: state.underline = true; break;
      case 7: state.reverse = true; break;
      case 22: state.bold = false; state.dim = false; break;
      case 23: state.italic = false; break;
      case 24: state.underline = false; break;
      case 27: state.reverse = false; break;
      case 39: state.fg = undefined; break;
      case 49: state.bg = undefined; break;
      case 38:
      case 48: {
        const target = code === 38 ? "fg" : "bg";
        const kind = params[i + 1];
        if (kind === 5) {
          state[target] = xterm256(params[i + 2] ?? -1);
          i += 2;
        } else if (kind === 2) {
          const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
          if (r !== undefined && g !== undefined && b !== undefined) {
            state[target] = `rgb(${r},${g},${b})`;
          }
          i += 4;
        }
        break;
      }
      default:
        if (code >= 30 && code <= 37) state.fg = BASE16[code - 30];
        else if (code >= 90 && code <= 97) state.fg = BASE16[code - 82];
        else if (code >= 40 && code <= 47) state.bg = BASE16[code - 40];
        else if (code >= 100 && code <= 107) state.bg = BASE16[code - 92];
        // Anything else is a style paddock does not render (blink, framed,
        // fonts). Ignored deliberately: dropping an unknown attribute shows
        // the text plainly, which beats refusing to render the line.
        break;
    }
  }
}

function spanFrom(text: string, state: State): AnsiSpan {
  // `reverse` is resolved here rather than carried to CSS, so the renderer
  // never has to know about it. Swapping at paint time keeps the span's fg/bg
  // meaning "what this actually looks like".
  const fg = state.reverse ? state.bg : state.fg;
  const bg = state.reverse ? state.fg : state.bg;
  const span: AnsiSpan = { text };
  if (fg) span.fg = fg;
  if (bg) span.bg = bg;
  if (state.bold) span.bold = true;
  if (state.dim) span.dim = true;
  if (state.italic) span.italic = true;
  if (state.underline) span.underline = true;
  return span;
}

/**
 * Split one line into styled spans.
 *
 * A line with no escapes returns exactly one unstyled span, so the common case
 * costs one allocation and the renderer needs no special path for plain text.
 * An empty line returns one empty span rather than none, so it still occupies
 * a row on screen.
 */
export function parseAnsiLine(line: string, initial?: State): AnsiSpan[] {
  const state = initial ?? fresh();
  const spans: AnsiSpan[] = [];
  let last = 0;

  ANSI_RE.lastIndex = 0;
  for (let m = ANSI_RE.exec(line); m !== null; m = ANSI_RE.exec(line)) {
    if (m.index > last) spans.push(spanFrom(line.slice(last, m.index), state));
    // Group 1 is present only for SGR; every other alternative is dropped.
    if (m[1] !== undefined) {
      applySgr(m[1] === "" ? [] : m[1].split(";").map((p) => Number(p) || 0), state);
    }
    last = m.index + m[0].length;
  }

  if (last < line.length) spans.push(spanFrom(line.slice(last), state));
  if (spans.length === 0) spans.push(spanFrom("", state));
  return spans;
}

/**
 * Parse a whole pane, carrying style ACROSS lines.
 *
 * Terminal styling does not reset at a newline: a TUI that opens a colour on
 * one row and closes it three rows later is normal, and parsing each line from
 * a clean slate drops the colour on every row but the first.
 */
export function parseAnsi(lines: string[]): AnsiSpan[][] {
  const state = fresh();
  return lines.map((line) => parseAnsiLine(line, state));
}
