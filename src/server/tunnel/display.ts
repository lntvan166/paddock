import { formatCode } from "@server/tunnel/pairing";
import { duration } from "@server/term";
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
