import { useEffect, useState } from "react";

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
const AGENT_HASH_RE = /^#\/agent\/(.+)$/;

/** Agent ids contain a colon (`w1:p1`), so the id is encoded in the hash. */
export function agentHash(agentId: string): string {
  return `#/agent/${encodeURIComponent(agentId)}`;
}

/**
 * The agent id addressed by a hash, or null for the list.
 *
 * Returns null rather than throwing on a malformed escape (`#/agent/%`), so a
 * hand-edited or truncated URL lands the operator on the list instead of
 * crashing the render.
 */
export function agentIdFromHash(hash: string): string | null {
  const encoded = AGENT_HASH_RE.exec(hash)?.[1];
  if (encoded === undefined) return null;
  try {
    const id = decodeURIComponent(encoded);
    // `#/agent/` with nothing after it addresses no agent. Returning "" would
    // send the caller looking up an agent whose id is the empty string.
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

export function useAgentRoute(): string | null {
  const [id, setId] = useState(() => agentIdFromHash(location.hash));
  useEffect(() => {
    const onChange = () => setId(agentIdFromHash(location.hash));
    addEventListener("hashchange", onChange);
    // Re-read on mount as well: the hash can change between the initial
    // useState and the listener being attached.
    onChange();
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return id;
}
