/**
 * The agent URL shape, in shared rather than web, because BOTH sides need it:
 * the UI to route, and the notifier to build a deep link into a message. The
 * dependency rule forbids src/server importing @web/, and duplicating the
 * format would give a notification link its own copy to drift from.
 */

/**
 * Hash routing, not history routing, and not component state.
 *
 * The terminal view needs to be a real address for three reasons: it can be
 * opened in a second browser tab alongside the list, it survives a reload
 * (a phone backgrounding the browser mid-triage does not lose the agent), and
 * it gives the roadmap's per-agent deep link somewhere to point — a push
 * notification about a blocked agent should open that agent, not the list.
 *
 * The hash rather than a path because paddock serves a single static bundle
 * with no server-side route table: a real path would 404 on a cold load of
 * `/agent/w1:p1` unless every unknown path were rewritten to the app, and a
 * catch-all rewrite would also swallow genuine 404s from `/api/*` typos.
 */
/**
 * Both prefixes, and that is permanent.
 *
 * `#/agent/<id>` is what the notifier emitted for every Telegram message ever
 * sent, and those messages are still in operators' chat histories. So the old
 * form must keep parsing forever, even though nothing emits it any more.
 * Since `agentId` and `paneId` are the same string — herdr's `pane_id` — the
 * two forms address the same thing and no link ever breaks.
 */
const PANE_HASH_RE = /^#\/(?:agent|pane)\/(.+)$/;

/** Pane ids contain a colon (`w1:p1`), so the id is encoded in the hash. */
export function paneHash(paneId: string): string {
  return `#/pane/${encodeURIComponent(paneId)}`;
}

/** Retained so no existing call site breaks: an alias, not a second format —
 *  new code emits `#/pane/...` via `paneHash` regardless of which name calls
 *  it. */
export const agentHash = paneHash;

/**
 * The pane id addressed by a hash, or null for the list.
 *
 * Accepts both `#/agent/<id>` (legacy, still out there in Telegram history)
 * and `#/pane/<id>` (current). Returns null rather than throwing on a
 * malformed escape (`#/pane/%`), so a hand-edited or truncated URL lands the
 * operator on the list instead of crashing the render.
 */
export function agentIdFromHash(hash: string): string | null {
  const encoded = PANE_HASH_RE.exec(hash)?.[1];
  if (encoded === undefined) return null;
  try {
    const id = decodeURIComponent(encoded);
    // `#/pane/` with nothing after it addresses no pane. Returning "" would
    // send the caller looking up an agent whose id is the empty string.
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

/**
 * The space URL shape, here rather than in `src/web/` for the reason the file's
 * opening note gives about `paneHash`: this is where hash formats live, and a
 * format kept somewhere else is a format free to drift from the parser.
 *
 * `#/space/<id>` singular against `#/spaces` plural — the collection and one
 * member of it. The trailing slash in the pattern is what keeps them apart, so
 * `#/spaces` can never parse as a space whose id is "s".
 */
const SPACE_HASH_RE = /^#\/space\/(.+)$/;

export function spaceHash(spaceId: string): string {
  return `#/space/${encodeURIComponent(spaceId)}`;
}

/** The space id addressed by a hash, or null for anything else. Returns null
 *  rather than throwing on a malformed escape (`#/space/%`), the same rule
 *  `agentIdFromHash` follows and for the same reason. */
export function spaceIdFromHash(hash: string): string | null {
  const encoded = SPACE_HASH_RE.exec(hash)?.[1];
  if (encoded === undefined) return null;
  try {
    const id = decodeURIComponent(encoded);
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

/**
 * The file viewer's address.
 *
 * Its own route rather than a sheet over the terminal, for the reason the pane
 * hash gives above: a phone backgrounds tabs, and a reload must not lose what
 * the operator was looking at. That is also why `GET /api/files/:id/meta`
 * exists — coming back from a reload, the id is all there is.
 *
 * Anchored to EXACTLY 32 hex characters, which is what the server issues.
 * Nothing else parses, so a hash that merely looks file-shaped —
 * `#/file/../../etc/passwd` — is not a file id and never reaches a route.
 */
const FILE_HASH_RE = /^#\/file\/([0-9a-f]{32})$/;

export function fileHash(id: string): string {
  return `#/file/${id}`;
}

export function fileIdFromHash(hash: string): string | null {
  return FILE_HASH_RE.exec(hash)?.[1] ?? null;
}
