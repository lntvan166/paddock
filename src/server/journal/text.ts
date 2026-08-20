import type { JournalEntry } from "@server/journal/types";

/** Ceiling on one turn's prose. Generous for a message, bounded on the wire. */
export const MAX_TEXT_CHARS = 4_000;

/** Ceiling on a tool summary line. Orientation, never a transcript. */
const MAX_TOOL_HINT = 80;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]|[()][A-Za-z0-9]|./g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * A digit-numbered option row, cursor optional: "1. Yes", "❯ 2. No",
 * "1) Yes", "> 3) No, keep it". `>` is treated the same as `❯` — the glyph
 * is not universal and ASCII `>` is at least as common a cursor marker.
 *
 * No length cap on the label: length must never decide whether a row is an
 * option, or a long real option (e.g. "❯ 1. Yes, and also run the full
 * regression suite before merging") would survive whole.
 */
const DIGIT_OPTION_RE = /^\s*(?:[❯>]\s*)?\d+[.)]\s+\S.*$/;

/**
 * A lettered option row, cursor REQUIRED: "❯ a. Yes". Without a cursor, a
 * bare "a. done" is too easily real prose — over-stripping is the worse
 * failure than the one this guards, so a lettered row only counts as an
 * option when a cursor marks it as selected.
 */
const CURSOR_LETTER_OPTION_RE = /^\s*[❯>]\s*[A-Za-z][.)]\s+\S.*$/;

function isOptionRow(line: string): boolean {
  return DIGIT_OPTION_RE.test(line) || CURSOR_LETTER_OPTION_RE.test(line);
}

/**
 * Remove option rows from journal text, dropped line by line, leaving "" if
 * every line was one.
 *
 * WHY LINE BY LINE: a real prompt is a question plus two or more option
 * lines, not one bare option line on its own. Matching the anchored pattern
 * against the WHOLE turn text only ever fires on that single-line toy case;
 * a real multi-line menu — "Do you want to proceed?\n❯ 1. Yes\n  2. No" —
 * would sail through unchanged. Splitting into lines and dropping only the
 * ones shaped like options is what strips the menu down to its question.
 *
 * WHY a bare cursor on non-option text is KEPT, not stripped: journal lines
 * are blended directly above the live screen with no divider (design
 * decision 3), and a menu from an already-answered question reading as the
 * live prompt is the specific failure `prompt-parse.ts` already records. But
 * a cursor glyph sitting on ordinary prose — "❯ npm install" quoted in a
 * message — is not that hazard, and deleting it would silently eat real
 * content, which is the worse failure this function exists to avoid.
 */
export function stripMenu(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isOptionRow(line))
    .join("\n");
}

/**
 * Truncate to AT MOST `max` characters, ellipsis included, so a cut is never
 * mistaken for the end and a caller's cap is never off by one.
 */
export function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * One line for a tool call: its name, and a short hint at what it touched.
 *
 * Never its RESULT. Tool results are where file contents, command output and
 * any secret that passed through the agent live, and design decision 4 keeps
 * them off the wire entirely.
 */
export function summariseTool(name: string, input: unknown): string {
  const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const raw =
    typeof obj.description === "string" ? obj.description
    : typeof obj.file_path === "string" ? obj.file_path.split("/").pop() ?? ""
    : typeof obj.pattern === "string" ? obj.pattern
    : "";
  const hint = stripAnsi(raw).replace(/\s+/g, " ").trim();
  // Clamped on the FINISHED line, not on the hint, so the cap holds whatever
  // the tool name's length happens to be.
  return clamp(hint === "" ? name : `${name} · ${hint}`, MAX_TOOL_HINT);
}

/** `13:04` from an ISO stamp, or "" when the record carried none. */
function hhmm(at: string | null): string {
  if (at === null) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? ""
    : `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Flatten turns to the lines the terminal renders.
 *
 * Server-side, because the client must gain no per-harness knowledge — the same
 * reason `parsePrompt` lives on this side of the socket.
 */
export function toLines(entries: readonly JournalEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const body = clamp(stripMenu(stripAnsi(e.text)).trim(), MAX_TEXT_CHARS);
    if (body === "" && e.tools.length === 0) continue;
    const who = e.role === "user" ? "you" : "agent";
    const time = hhmm(e.at);
    out.push(time === "" ? who : `${who} · ${time}`);
    if (e.tools.length > 0) out.push(`▸ ${e.tools.join(" · ")}`);
    if (body !== "") out.push(...body.split("\n"));
    out.push("");
  }
  return out;
}
