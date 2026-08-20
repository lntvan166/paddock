import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { containedRealpath, isSessionId } from "@server/journal/files";
import { summariseTool } from "@server/journal/text";
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
 * a person typed. `isSidechain` marks subagent traffic.
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
      } catch {
        continue; // a root that does not exist is not an error, it is a miss
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
      const entry = toEntry(rec);
      if (entry !== null) out.push(entry);
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
    // A STRING is a person typing. A LIST is tool-result traffic wearing the
    // user role, and rendering those would fabricate hundreds of "you" turns.
    if (typeof content !== "string" || content.trim() === "") return null;
    return { role: "user", at, text: content, tools: [] };
  }

  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  const tools: string[] = [];
  for (const part of content) {
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
    else if (p.type === "tool_use" && typeof p.name === "string") {
      tools.push(summariseTool(p.name, p.input));
    }
    // "thinking" and everything unknown falls through deliberately.
  }
  if (texts.length === 0 && tools.length === 0) return null;
  return { role: "assistant", at, text: texts.join("\n"), tools };
}
