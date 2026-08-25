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
