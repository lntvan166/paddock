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
 * A cursor-marked row, e.g. `❯ 1. Yes`, or a bare numbered option row.
 *
 * Requires the row to be ONLY the option — anchored both ends, short label —
 * so ordinary prose that happens to open with a number survives. Over-stripping
 * silently eats real content, which is a worse failure than the one this
 * guards.
 */
const MENU_RE = /^\s*(?:❯\s*)?\d{1,2}\.\s+\S[^\n]{0,60}$/;
const CURSOR_ONLY_RE = /^\s*❯\s*\S[^\n]{0,60}$/;

/**
 * Remove an option row from journal text, leaving "" if that is all it was.
 *
 * WHY: journal lines are blended directly above the live screen with no
 * divider (design decision 3). A menu from an already-answered question would
 * then read as the live prompt — the failure `prompt-parse.ts` already records
 * in its own scoping comment. Only the live screen may show a selectable menu.
 */
export function stripMenu(text: string): string {
  if (MENU_RE.test(text) || CURSOR_ONLY_RE.test(text)) return "";
  return text;
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
