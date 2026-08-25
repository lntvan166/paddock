/**
 * How a literal the operator can TYPE is told apart from the prose around it.
 *
 * Measured complaint: "to reach this from your phone: paddock tunnel" — where
 * does the sentence end and the command begin? The codebase had three answers
 * at once (bare, 'single-quoted', `backticked`), which is the same as having
 * none, because none of them was reliable enough to trust.
 *
 * Backticks are the delimiter. Colour only DECORATES: `term.test.ts` asserts
 * that stripping every escape from a painted line returns the plain one, so a
 * piped log carries exactly the same information as a terminal. This is the
 * rule `tunnel/display.ts` already lives by, and the reason it matters here is
 * that `NO_COLOR`, a pipe, a CI log and a screenshot-in-an-issue all lose the
 * colour while keeping the text.
 *
 * A leaf on purpose: it imports nothing, so every layer from `herdr/socket.ts`
 * outward may use it without inverting the dependency direction in
 * docs/architecture.md.
 */

/**
 * `NO_COLOR` wins whether or not it has a value — by convention the variable's
 * PRESENCE is the signal. Off entirely when stdout is not a tty, so a piped log
 * never receives escape bytes.
 *
 * Lived in `tunnel/display.ts` until hints needed it too. One definition: two
 * would drift, and the failure mode is escape bytes in a log file that only
 * shows up under a pipe nobody tests interactively.
 */
export function useColour(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if ("NO_COLOR" in env) return false;
  return isTty;
}

/**
 * Emphasise every backticked span in `line`, keeping the backticks.
 *
 * Applied at the PRINT boundary, not inside the message builders. The builders
 * — `portInUseMessage`, `herdrUnreachableMessage`, `shapeMessage`, the
 * preflight hints — are pure functions whose whole value is that they can be
 * asserted without a tty, and threading a `colour` flag through all of them
 * would have put a presentation concern into every signature and every test for
 * the sake of one escape sequence.
 *
 * The backticks are retained under colour rather than consumed by it. Removing
 * them would make the coloured output carry information the plain output lost,
 * which is the exact thing the strip-equals-plain test forbids.
 *
 * `[^`\n]+` and not `[^`]+`: a span may not straddle a newline, so one unpaired
 * backtick cannot pair with another on a later line and swallow everything
 * between them. The `+` leaves an empty ` `` ` alone — it names no command.
 */
/**
 * The three answers any diagnostic command can give. `unknown` is the one that
 * earns its place: `runStatus`'s `unreadable` and `doctorReport`'s exit code 2
 * both mean "could not decide", and both used to be typeset identically to the
 * outcomes they are NOT.
 */
export type Outcome = "yes" | "no" | "unknown";

/**
 * The glyph, not the colour, is what carries the distinction.
 *
 * This file's rule is that colour decorates and never informs — a piped log
 * must read identically to a terminal. A glyph survives escape-stripping, so
 * `NO_COLOR`, a pipe, a CI log, a screenshot in an issue and a colourblind
 * reader all keep the three-way distinction that `paint` merely decorates.
 */
export function glyph(o: Outcome): string {
  return o === "yes" ? "✓" : o === "no" ? "✗" : "⚠";
}

const GLYPH_COLOUR: Record<string, string | undefined> = {
  "✓": "32",
  "✗": "31",
  "⚠": "33",
};

export function paint(line: string, colour: boolean): string {
  if (!colour) return line;
  const spans = line.replace(/`[^`\n]+`/g, (span) => `\x1b[1;36m${span}\x1b[0m`);
  // A LEADING glyph only, per line — `m` for doctor's multi-line report. A
  // glyph mid-sentence is prose ("the ✓ means compatible") and colouring it
  // would be colour informing rather than decorating.
  return spans.replace(
    /^([ \t]*)([✓✗⚠])/gm,
    (_m, pad: string, g: string) => `${pad}\x1b[${GLYPH_COLOUR[g]}m${g}\x1b[0m`,
  );
}

/**
 * The two operator-facing sinks. Everything a person is meant to READ goes
 * through one of these; `console.*` stays for the `herdr:` diagnostics, which
 * are a trace rather than a message.
 *
 * Colour is decided per STREAM, not once for the process: a run whose stdout is
 * piped to a file while stderr stays on the terminal must not put escape bytes
 * in the file, and `paddock status > out.txt` is an ordinary thing to type.
 *
 * `isTTY` is read at call time rather than captured at import, because these
 * are used by a compiled binary whose stdout may be reassigned before main
 * runs, and a stale capture would be wrong in the direction that writes escapes
 * into a log.
 */
export function say(line: string): void {
  console.log(paint(line, useColour(process.env, Boolean(process.stdout.isTTY))));
}

export function warn(line: string): void {
  console.error(paint(line, useColour(process.env, Boolean(process.stderr.isTTY))));
}

/**
 * A span of milliseconds as a person would say it: at most TWO units, largest
 * first, day-aware.
 *
 *   100h 30m  ->  4d 4h
 *   3h 12m    ->  3h 12m
 *   45m 20s   ->  45m 20s
 *   30s       ->  30s
 *
 * There were two of these — `human()` in `tunnel/display.ts` and `uptime()` in
 * `lifecycle/commands.ts` — and BOTH stopped at hours, which is how a tunnel
 * up for four days came to report `100h 30m`. One bug written twice is why
 * this lives here rather than being fixed in place.
 *
 * Two units and not three: `display.ts` redraws this string once a second in a
 * live block, and a unit appearing or disappearing changes the block's width.
 * The second unit is printed even at zero (`4d 0h`, `1h 0m`) for exactly the
 * same reason — `human()` already behaved this way and it was right to.
 *
 * Negative input clamps to `0s`. A clock that has passed its deadline is at
 * zero, not in the past.
 */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * A fixed-width progress bar as a plain string. Pure, so its edges are
 * assertable with no terminal — which is the whole reason it lives in this
 * leaf rather than beside the code that redraws it.
 *
 * A `fraction` outside `0..1` is CLAMPED rather than refused: a server that
 * sends more bytes than its own `content-length` promised must not crash an
 * update over a cosmetic bar. `NaN` clamps to empty for the same reason.
 *
 * Below a `width` of 8 there is no bar that means anything — two brackets and
 * a couple of cells is a decoration, not a measurement — so it returns the
 * empty string and the caller prints the percentage alone.
 */
export function bar(fraction: number, width: number): string {
  if (width < 8) return "";
  const f = Number.isNaN(fraction) ? 0 : Math.min(1, Math.max(0, fraction));
  const inner = width - 2;
  const filled = Math.round(inner * f);
  const head =
    filled === 0 ? "" : filled >= inner ? "=".repeat(inner) : `${"=".repeat(filled - 1)}>`;
  return `[${head}${" ".repeat(inner - filled)}]`;
}
