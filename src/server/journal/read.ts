import { adapterFor } from "@server/journal/registry";
import { claudeRoots, MAX_TAIL_BYTES, tailChunk } from "@server/journal/files";
import { toLines } from "@server/journal/text";
import type { JournalRoots } from "@server/journal/types";
import type { HerdrAgentSession } from "@shared/herdr-api";

export interface JournalPage {
  lines: string[];
  /**
   * `"reconstruction"` is the server saying "I have no journal for this
   * agent" — it always comes with `lines: []` and a `detail`. Reconstruction
   * itself is entirely client-side. This field is a ROUTING answer, not a
   * description of the payload.
   */
  source: "journal" | "reconstruction";
  hasMore: boolean;
  /** Opaque to the client: a byte offset it echoes back, never constructs. */
  cursor: string | null;
  detail: string | null;
}

export interface JournalReader {
  read(
    session: HerdrAgentSession | null | undefined,
    before: number | null,
    limit: number,
  ): Promise<JournalPage>;
}

const none = (detail: string): JournalPage => ({
  lines: [], source: "reconstruction", hasMore: false, cursor: null, detail,
});

export function createJournalReader(roots: JournalRoots): JournalReader {
  return {
    async read(session, before, limit) {
      const adapter = adapterFor(session);
      if (adapter === null || !session) return none("no journal adapter for this harness");

      const path = await adapter.locate(session.value, roots.claude);
      if (path === null) return none("session log not found — compacted, rotated or removed");

      let size: number;
      try {
        size = Bun.file(path).size;
      } catch (err) {
        return none(`could not read the session log: ${String(err)}`);
      }

      const end = before ?? size;
      if (end <= 0) return { lines: [], source: "journal", hasMore: false, cursor: null, detail: null };

      const { text, startByte } = await tailChunk(path, end, MAX_TAIL_BYTES);
      // The first line of a tail read is usually a PARTIAL record. Dropping it
      // is correct rather than lossy: the next page, which starts earlier,
      // contains it whole.
      const usable = startByte > 0 ? text.slice(text.indexOf("\n") + 1) : text;
      const entries = adapter.parse(usable).slice(-limit);
      return {
        lines: toLines(entries),
        source: "journal",
        hasMore: startByte > 0,
        cursor: startByte > 0 ? String(startByte) : null,
        detail: null,
      };
    },
  };
}

/** Roots for the harnesses paddock reads, from the real environment. */
export function defaultRoots(env: Record<string, string | undefined>, home: string): JournalRoots {
  return { claude: claudeRoots(env, home) };
}
