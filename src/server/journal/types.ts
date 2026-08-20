/**
 * The journal axis: reading a coding agent's OWN session log.
 *
 * This module tree knows about harnesses (Claude Code, codex, pi) and nothing
 * about herdr. It must never import from `@server/herdr/` — see
 * `docs/architecture.md`. herdr's only contribution is the session id, handed
 * across as a plain string by the caller.
 */

/** One turn, already stripped of everything not being served. */
export interface JournalEntry {
  role: "user" | "assistant";
  /** ISO timestamp as the harness wrote it, or null if the record had none. */
  at: string | null;
  /** Prose only. ANSI removed, menus removed, truncated. */
  text: string;
  /** One-line tool summaries, e.g. "Bash ×3". Never tool OUTPUT. */
  tools: string[];
}

export interface JournalAdapter {
  /** Harness name, matching herdr's `agent_session.agent`. */
  name: string;
  /**
   * The harness version this adapter's record shape was last verified against.
   * A private on-disk format with no compatibility promise, so this is the
   * only honest way to record what "known good" means.
   */
  verifiedAgainst: string;
  /** Absolute path of the session's log, or null when it cannot be found. */
  locate(value: string, roots: readonly string[]): Promise<string | null>;
  /** Parse a raw slice of the log. Unknown records are ignored, never fatal. */
  parse(chunk: string): JournalEntry[];
}

/** Where each harness keeps its logs. A LIST: one machine can hold several. */
export interface JournalRoots {
  claude: readonly string[];
}
