import { randomBytes } from "node:crypto";

/**
 * The path↔id map behind the file routes.
 *
 * WHY IT EXISTS. `CLAUDE.md` forbids payloads in GET URLs, because they land in
 * edge access logs — and a file path is exactly such a payload. An
 * `<iframe src>` and a download link both need a plain GET, so the path is
 * POSTed once and this hands back something meaningless to put in the URL.
 *
 * WHAT IT IS NOT. Not a capability, not a secret, not an authorisation. Anything
 * that can reach paddock can POST a path and be given an id for it — that is the
 * design's stated scope, and `docs/decisions.md` records why a narrower one
 * would be theatre: `POST /api/panes/:id/text` can already `cat` any file into a
 * pane. The id is shorter than the path and says less in a log. That is all.
 *
 * In memory, capped, and it dies with the process. Nothing is persisted, and a
 * restart invalidating every open tab's ids is correct rather than unfortunate:
 * an id means nothing on its own, so there is nothing to preserve.
 */
export interface FileStore {
  /** The id for this path, reused if it already has one. */
  issue(path: string): string;
  /** The path behind an id, or null when it is unknown or evicted. */
  resolve(id: string): string | null;
}

/** 32 lowercase hex characters, which is what `issue` emits. */
export const FILE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * How many files may be addressable at once.
 *
 * Generous, because an id costs a path in memory and nothing else, and small
 * enough that a runaway caller cannot grow the map without bound.
 */
const DEFAULT_CAP = 200;

export function createFileStore(
  opts: { cap?: number; random?: () => string } = {},
): FileStore {
  const cap = Math.max(1, opts.cap ?? DEFAULT_CAP);
  const random = opts.random ?? (() => randomBytes(16).toString("hex"));

  // Insertion-ordered, which is what makes "evict the oldest" free.
  const byId = new Map<string, string>();
  const byPath = new Map<string, string>();

  return {
    issue(path) {
      const existing = byPath.get(path);
      if (existing !== undefined) return existing;

      const id = random();
      byId.set(id, path);
      byPath.set(path, id);

      while (byId.size > cap) {
        const oldest = byId.keys().next().value;
        if (oldest === undefined) break;
        const oldestPath = byId.get(oldest);
        byId.delete(oldest);
        // BOTH indexes, or the reverse one keeps handing back an id whose entry
        // no longer resolves — a link that silently 404s for the rest of the
        // process's life, which is worse than never having had it.
        if (oldestPath !== undefined) byPath.delete(oldestPath);
      }

      return id;
    },

    resolve(id) {
      return byId.get(id) ?? null;
    },
  };
}
