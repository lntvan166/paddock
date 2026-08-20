import { adapterFor } from "@server/journal/registry";
import { claudeRoots, MAX_TAIL_BYTES, tailChunk } from "@server/journal/files";
import { toLines } from "@server/journal/text";
import type { JournalEntry, JournalRoots } from "@server/journal/types";
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

      /**
       * FIXED PHRASES, never `String(err)`, and this is an exposure fix rather
       * than tidying. A Bun/Node filesystem error stringifies with the path it
       * failed on — `ENOENT: no such file or directory, open '<home>/.claude/
       * projects/…'` — and `routes.ts` returns `{ ok: true, ...page }`
       * verbatim, so a rotated or deleted log turned an ordinary miss into the
       * operator's home path, username and project layout going over the wire
       * to the browser. Design decision 5 says a filesystem key never reaches a
       * client that cannot need one, and a path in an error message is the same
       * key by another route.
       *
       * The RAW error is not lost: `reportJournalMiss` in `routes.ts` logs the
       * detail host-side, where `CLAUDE.md` requires it to be loud, and the
       * host is the side that can act on a path.
       */
      let size: number;
      try {
        size = Bun.file(path).size;
      } catch (err) {
        console.error("journal: could not read the session log", err);
        return none("could not read the session log");
      }

      /**
       * CLAMPED to the file, not trusted as given. `before` is format-validated
       * in the route (digits only) but that says nothing about its range, and a
       * cursor from a log that has since been compacted or rotated can sit far
       * past the current end. Unclamped, the reader then spends one whole
       * round trip per `MAX_TAIL_BYTES` walking back through bytes that do not
       * exist before it reaches any record — 512 KB of nothing per tap.
       * Clamping costs the operator no history: everything at or before `size`
       * is still reachable, because `size` IS the end of the file.
       */
      const end = Math.min(before ?? size, size);
      if (end <= 0) return { lines: [], source: "journal", hasMore: false, cursor: null, detail: null };

      let text: string;
      let startByte: number;
      try {
        ({ text, startByte } = await tailChunk(path, end, MAX_TAIL_BYTES));
      } catch (err) {
        // Distinct detail from the `.size` failure above: this is "the file
        // moved or lost permissions between locate() and the read", not "we
        // never got as far as opening it". Fixed phrase for the same reason as
        // that one — the raw error, path and all, goes to the host log.
        console.error("journal: could not read a page of the session log", err);
        return none("could not read a page of the session log");
      }

      /**
       * The cursor MUST be a record boundary — the byte where a "\n"-delimited
       * line starts — never a raw byte count, and never derived by measuring
       * the DECODED text forward from `startByte`. Two things break that:
       *
       *   - `hasMore`/`cursor` used to come from whether the tail read was
       *     BYTE-truncated, while the page was actually cut off by ENTRY
       *     COUNT (`.slice(-limit)`). A chunk read in one un-truncated pass
       *     (small file, or the last chunk of a big one) then reported
       *     `hasMore: false` even though it held more entries than `limit`
       *     and had just discarded the rest — false "no more". And when a
       *     chunk held more entries than `limit`, the discarded interior
       *     entries were never revisited, because the cursor still pointed at
       *     the whole chunk's start rather than where `limit` actually cut.
       *   - `startByte` marks an ARBITRARY byte, not a record boundary — a
       *     tail read routinely begins mid multi-byte character. Decoding
       *     that leading fragment replaces the stray bytes with U+FFFD, which
       *     re-encodes to a DIFFERENT byte length than the original bytes
       *     occupied. Measuring line lengths forward from `startByte` and
       *     accumulating them (as this function used to) bakes that
       *     discrepancy into every offset after it — the cursor lands a few
       *     bytes inside a record instead of at its start, so a record is
       *     silently dropped once as a "partial first line" and again as a
       *     corrupt trailing fragment on the next page's parse.
       *
       * The fix for both is to walk BACKWARDS from `end`, which is always
       * exact — it is either the file's real size or a cursor this same
       * function issued, and by induction every cursor this function issues
       * is itself exact. Working from that trustworthy edge, a line's byte
       * length is measured only once corruption (which exists solely at
       * `startByte`, the chunk's near edge) is behind it — so every offset
       * computed this way is faithful, right down to the boundary of the
       * first line we keep. The walk stops the instant `limit` entries are
       * collected OR the chunk's lines run out, and either way `cursor` is
       * the absolute offset of the START of whichever line was consumed
       * LAST — a genuine, uncorrupted record boundary.
       */
      const linesArr = text.split("\n");
      // The line nearest `startByte` is usually a PARTIAL record — a tail
      // read begins at an arbitrary byte. Excluding it from consideration
      // here is correct rather than lossy: the page this cursor leads to
      // reads up to exactly this boundary, so the same bytes arrive as that
      // page's OWN last line — complete, not partial — measured from ITS
      // exact right edge, and get parsed there instead.
      const firstUsable = startByte > 0 ? 1 : 0;

      /**
       * A window with no complete record in it at all — which is a real shape,
       * not a hypothetical: Claude Code writes tool_result records of several
       * hundred KB, and one wider than `MAX_TAIL_BYTES` fills an entire window
       * with no "\n" to cut on.
       *
       * There is no record boundary to hand back, so paging steps to the
       * window's own start. That is the ONE cursor this function issues which
       * is not a boundary, and it is the only way past a record that cannot be
       * read at all — the turns recorded EARLIER than it are still perfectly
       * readable, so stopping here would hide all of them.
       *
       * Said out loud, because the alternative is an empty page with
       * `hasMore: true` and no explanation: the operator taps "show earlier",
       * sees nothing, and nothing anywhere records why. The oversized record
       * is genuinely lost — a bounded read cannot serve it — and a loss this
       * feature cannot avoid is exactly the kind it has to report.
       */
      if (!linesArr.slice(firstUsable).some((l) => l.trim() !== "")) {
        return {
          lines: [],
          source: "journal",
          hasMore: startByte > 0,
          cursor: startByte > 0 ? String(startByte) : null,
          detail:
            `no complete record in the ${MAX_TAIL_BYTES}-byte window ending at byte ${end} — ` +
            "a single record larger than the window, or a log that shrank while it was read",
        };
      }

      const entries: JournalEntry[] = [];
      // Falls back to the chunk's own start when literally nothing below is
      // consumable (e.g. the chunk holds only the excluded partial first
      // line) — still a real, previously-computed byte offset, so the next
      // request makes forward progress instead of looping on `before`.
      let oldestOffset = startByte;
      let pos = end;
      for (let i = linesArr.length - 1; i >= firstUsable; i--) {
        const line = linesArr[i]!;
        const lineStart = pos - Buffer.byteLength(line, "utf8");
        pos = lineStart - 1; // step back over the "\n" this split consumed
        if (line.trim() === "") continue;
        entries.unshift(...adapter.parse(line));
        oldestOffset = lineStart;
        if (entries.length >= limit) break;
      }

      return {
        lines: toLines(entries),
        source: "journal",
        hasMore: oldestOffset > 0,
        cursor: oldestOffset > 0 ? String(oldestOffset) : null,
        detail: null,
      };
    },
  };
}

/** Roots for the harnesses paddock reads, from the real environment. */
export function defaultRoots(env: Record<string, string | undefined>, home: string): JournalRoots {
  return { claude: claudeRoots(env, home) };
}
