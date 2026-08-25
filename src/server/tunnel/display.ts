import { formatCode } from "@server/tunnel/pairing";
import { duration } from "@server/term";
import type { QrMatrix } from "@server/qr";
// Re-exported: `useColour` moved to the `term.ts` leaf when hint output needed
// it too, and this module's importers already had it from here. `duration`
// replaces this module's own `human()`, which stopped at hours — see term.ts.
export { duration, useColour } from "@server/term";

export interface DisplayState {
  url: string;
  code: string;
  codeExpiresAt: number;
  paired: number;
  startedAt: number;
  /** Epoch ms, or null when `--for` was not given. */
  deadline: number | null;
  now: number;
  /**
   * The QR to draw, or null for no QR at all.
   *
   * PRESENCE, not polarity. `run.ts` passes null when the terminal is not a
   * tty, when `NO_COLOR` is set, or when it is too narrow — never by way of
   * `render`'s `colour` flag, because the strip-equals-plain assertion in
   * `tunnel-display.test.ts` requires that flag to change escapes and nothing
   * else.
   */
  qr: QrMatrix | null;
  /**
   * Drop the prose — the public-tunnel warning and the `^C` hint — because the
   * terminal is too short for it AND the QR. State stays: `paired` and
   * `closes in` are the two lines that change while an operator watches.
   */
  compact: boolean;
}

/** Four modules on every side. See the note in `qrLines`. */
const QUIET = 4;

/**
 * A matrix as terminal lines, quiet zone included.
 *
 * Half-blocks, not one cell per module: a QR module is square and a terminal
 * cell is roughly 1:2, so one-per-cell gives a QR stretched 2x vertically that
 * often will not scan. Two spaces per module fixes the aspect and doubles the
 * width to ~74 columns. `█ ▀ ▄` and space pack two vertical modules into one
 * cell via foreground and background: square modules, 37 columns, 19 rows.
 *
 * The quiet zone is not decoration and must not be trimmed to save rows. It is
 * the most common reason a hand-made terminal QR fails to scan — it looks like
 * wasted space, so it goes, and scanners stop finding the finder patterns.
 *
 * Colour forces black-on-white rather than inheriting the theme. QR means
 * dark-on-light; on a dark terminal the light modules render dark and the
 * symbol is inverted, which not every scanner recovers from. The GLYPHS carry
 * the information and survive escape-stripping — colour only pins the
 * polarity, which is what keeps this inside the rule that colour never informs.
 */
export function qrLines(m: QrMatrix, colour: boolean): string[] {
  const n = m.size + QUIET * 2;
  const dark = (row: number, col: number): boolean => {
    const r = row - QUIET;
    const c = col - QUIET;
    if (r < 0 || c < 0 || r >= m.size || c >= m.size) return false;
    return m.isDark(r, c);
  };

  const lines: string[] = [];
  for (let row = 0; row < n; row += 2) {
    let out = "";
    for (let col = 0; col < n; col++) {
      const top = dark(row, col);
      // An odd-height field pairs its last row against a LIGHT row rather than
      // reading off the end of the matrix.
      const bottom = row + 1 < n ? dark(row + 1, col) : false;
      out += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    // 30;47 — black on white, the standard pair rather than truecolor, because
    // a QR only needs two colours and 30/47 works on terminals that have never
    // heard of 24-bit escapes.
    lines.push(colour ? `\x1b[30;47m${out}\x1b[0m` : out);
  }
  return lines;
}


const devices = (n: number) =>
  n === 0 ? "no devices yet" : n === 1 ? "1 device" : `${n} devices`;

/**
 * Pure: state in, block out. The loop in `run.ts` only decides WHEN to draw.
 *
 * Colour decorates and never informs — `tunnel-display.test.ts` asserts that
 * stripping every escape from the coloured render returns the plain one, so a
 * piped log and a terminal read identically. Do not make a distinction that
 * exists only in colour.
 */
export function render(s: DisplayState, colour: boolean): string {
  const c = (code: string, text: string) =>
    colour ? `\x1b[${code}m${text}\x1b[0m` : text;

  const lines = [
    `  ${c("32", "✓")} tunnel up · ${duration(s.now - s.startedAt)} elapsed`,
    `    ${c("36", s.url)}`,
    "",
    `    code ${formatCode(s.code)} · expires in ${duration(s.codeExpiresAt - s.now)}`,
    `    paired: ${devices(s.paired)}`,
  ];
  if (s.deadline !== null) lines.push(`    closes in ${duration(s.deadline - s.now)}`);
  lines.push(
    "",
    `  ${c("33", "⚠")} a quick tunnel is public. The code above is the only thing`,
    "    between this URL and keystroke access to every agent here.",
    "    For anything lasting, use a named tunnel behind Cloudflare",
    "    Access — docs/deploy-cloudflare.md",
    "",
    `  ${c("2", "^C to close")}`,
  );
  return lines.join("\n");
}
