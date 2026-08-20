import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { containedRealpath, isSessionId } from "@server/journal/files";
import { stripInjected, summariseTools, type ToolCall } from "@server/journal/text";
import type { JournalAdapter, JournalEntry } from "@server/journal/types";

/**
 * Claude Code's journal adapter.
 *
 * WHY THIS EXISTS. A pane running Claude sits on the terminal's ALTERNATE
 * SCREEN, which has no scrollback ring, so `pane.read` can never return more
 * than the viewport however much is asked for — see
 * `docs/design/2026-08-20-journal-history-design.md` for the measurements. The
 * history does exist, in Claude Code's own session log, and herdr hands us its
 * uuid on `agent_session`.
 *
 * SHAPE OF THE SOURCE. This is a PRIVATE on-disk format with no compatibility
 * promise; it will change without notice. Every unknown record type is ignored
 * rather than fatal, and one unparseable line is skipped rather than costing
 * the file. `verifiedAgainst` records when the shape was last checked by hand —
 * update it whenever you re-check, the way `docs/gotchas.md` treats every other
 * measured claim in this repo.
 *
 *   {"type":"user",      "message":{"role":"user","content":"…" | [ {type:"tool_result"} ]}}
 *   {"type":"assistant", "message":{"role":"assistant","content":[ {type:"text"|"thinking"|"tool_use"} ]}}
 *
 * A `user` record whose content is a LIST is tool-result traffic, not something
 * a person typed. `isSidechain` marks subagent traffic — but only at the
 * record's TOP LEVEL, so it is not sufficient on its own: a subagent's output
 * also arrives as an injected `<result>` block inside an unmarked record's
 * string content. See `stripInjected` in `text.ts`.
 */
export const claudeAdapter: JournalAdapter = {
  name: "claude",
  verifiedAgainst: "Claude Code 2.1.220, checked 2026-08-20",

  async locate(value, roots) {
    // Checked before any filesystem call — see files.ts.
    if (!isSessionId(value)) return null;
    for (const root of roots) {
      let projects: string[];
      try {
        projects = await readdir(root);
      } catch (err) {
        // ENOENT is an ordinary miss: this root simply has no journal here.
        // Anything else (e.g. EACCES) is a host-side fault — the same
        // distinction containedRealpath makes for its root argument — so it
        // must be loud even though the caller still only ever sees `null`.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.error(`journal: root did not read, check CLAUDE_CONFIG_DIR: ${root}`, err);
        }
        continue;
      }
      for (const project of projects) {
        const found = await containedRealpath(root, join(root, project, `${value}.jsonl`));
        if (found !== null) return found;
      }
    }
    return null;
  },

  parse(chunk) {
    const out: JournalEntry[] = [];
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A partial first line is NORMAL: a tail read starts mid-record. A
        // genuinely corrupt line costs itself and nothing else.
        continue;
      }
      // toEntry is called INSIDE this try, not after it: JSON.parse succeeding
      // is no guarantee the record's shape is one toEntry can safely walk (a
      // content element can be `null`, a string, a number — anything valid
      // JSON allows). This is a private, unversioned format, so a shape
      // nobody has seen yet must cost only this record, never the file.
      try {
        const entry = toEntry(rec);
        if (entry !== null) out.push(entry);
      } catch {
        continue;
      }
    }
    return out;
  },
};

function toEntry(rec: Record<string, unknown>): JournalEntry | null {
  const type = rec.type;
  if (type !== "user" && type !== "assistant") return null; // bookkeeping rows
  if (rec.isSidechain === true) return null; // subagent traffic

  const at = typeof rec.timestamp === "string" ? rec.timestamp : null;
  const message = rec.message as { content?: unknown } | undefined;
  const content = message?.content;

  if (type === "user") {
    // A LIST is tool-result traffic wearing the user role, and rendering those
    // would fabricate hundreds of "you" turns.
    if (typeof content !== "string" || content.trim() === "") return null;
    /**
     * A STRING is NOT, on its own, "a person typing" — that rule was the leak.
     * The harness injects its own blocks into this same field: subagent
     * `<result>` bodies, `<task-notification>`/`<output-file>` rows,
     * `<system-reminder>`s, `<local-command-stdout>`, and the
     * `<command-name>`/`<command-message>`/`<command-args>` triple a slash
     * command expands to. All of that is tool output or harness bookkeeping,
     * which design decision 4 says is never served — and `<result>` in
     * particular is how a SIDECHAIN's output reaches a record whose top-level
     * `isSidechain` is absent, so the check above cannot see it.
     *
     * Stripped rather than dropped, and then dropped if nothing prose-shaped
     * is left: see `stripInjected` for why both halves are needed. Note the
     * order — stripping happens HERE, before `toLines` clamps to
     * `MAX_TEXT_CHARS`, because clamping first would have served the first
     * 4 KB of a block instead of none of it.
     */
    const text = stripInjected(content);
    if (text.trim() === "") return null;
    return { role: "user", at, text, tools: [] };
  }

  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  for (const part of content) {
    // A content element is allowed to be anything valid JSON permits — this
    // is a private, unversioned format. `null`, a bare string, a number: none
    // of those are an object, so skip them here rather than relying solely on
    // the outer try/catch to survive a shape like `[null, {"type":"text",…}]`.
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
    else if (p.type === "tool_use" && typeof p.name === "string") {
      // Collected raw and summarised together at the end: a run of the same
      // tool collapses to `Bash ×3`, which cannot be decided one call at a
      // time.
      calls.push({ name: p.name, input: p.input });
    }
    // "thinking" and everything unknown falls through deliberately.
  }
  if (texts.length === 0 && calls.length === 0) return null;
  return { role: "assistant", at, text: texts.join("\n"), tools: summariseTools(calls) };
}
