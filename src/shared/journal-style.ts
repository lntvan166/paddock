/**
 * How a journal transcript's speaker and tool lines are painted.
 *
 * Shared because two producers emit the same transcript shape: `toLines` on
 * the server, and the invented demo transcript both demo hosts serve
 * (`demo-history.ts`). A screenshot must show what the product shows.
 *
 * Colour lives in the LINE, as ANSI, rather than in client CSS for the same
 * reason the journal's markdown does (`renderMarkdown`): the client renders
 * journal lines through the ANSI parser it already runs for the live screen,
 * and stays free of any knowledge that a journal exists.
 *
 * Fixed truecolour is safe here because the terminal ground never re-themes
 * (`--term-bg` is the same dark in every theme). Reported from a phone: every
 * header and tool line was the same grey as the prose, so finding where the
 * operator's own message started meant reading the whole screen.
 */

const OFF = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
/** paddock's accent as it reads on a dark ground. */
const YOU = "\x1b[38;2;224;138;99m";
/** Distinct from the accent, and from the periwinkle used for inline code. */
const AGENT = "\x1b[38;2;95;215;196m";

/** `you · 13:04`: the speaker bold in its colour, the time dimmed. */
export function speakerLine(who: "you" | "agent", time: string): string {
  const name = `${BOLD}${who === "you" ? YOU : AGENT}${who}${OFF}`;
  return time === "" ? name : `${name}${DIM} · ${time}${OFF}`;
}

/**
 * `▸ Bash · …`, dimmed whole. A tool line names a call whose output is not in
 * the transcript, so it steps back and lets the prose around it lead.
 */
export function toolLine(summary: string): string {
  return `${DIM}▸ ${summary}${OFF}`;
}
