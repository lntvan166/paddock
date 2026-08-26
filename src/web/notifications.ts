import { useEffect } from "react";
import type { Agent } from "@shared/types";

/**
 * Closing notifications that no longer describe anything.
 *
 * `public/sw.js` is NOT involved and is not touched: it already tags every
 * notification with the agent id, which is everything this needs. That keeps
 * the no-`fetch`-handler assertion in `tests/sw.test.ts` true and leaves
 * decision 23 unamended.
 *
 * The alternative — pushing on `blocked -> working` with a flag telling the
 * worker to close the tag and render nothing — would clear the lock screen
 * without the phone being touched, which is why it will keep getting proposed.
 * WebKit counts a push that shows no notification against the subscription and
 * can revoke it, so this sweep is the version that does not spend the
 * subscription to save a buzz.
 */

/** The states a notification can still be TRUE about. */
const LIVE = new Set<Agent["state"]>(["blocked", "done"]);

async function registration(): Promise<ServiceWorkerRegistration | null> {
  const sw = globalThis.navigator?.serviceWorker;
  // Capability detection, not a swallowed error: a browser with no service
  // worker has no notifications to close, and nothing has failed.
  if (sw === undefined) return null;
  try {
    return (await sw.getRegistration()) ?? null;
  } catch (e) {
    console.info(`paddock: could not reach the service worker: ${(e as Error).message}`);
    return null;
  }
}

/** Close this agent's notification. Called when you open its pane. */
export async function closeFor(agentId: string): Promise<void> {
  const reg = await registration();
  if (reg?.getNotifications === undefined) return;
  for (const n of await reg.getNotifications({ tag: agentId })) n.close();
}

/**
 * Close every notification that is no longer true.
 *
 * An UNTAGGED notification is never closed. `sw.js` falls back to
 * "paddock: an agent needs you" with an empty tag when it cannot read a
 * payload, and this cannot tell what that one was about — discarding it would
 * throw away the only trace of a real event.
 */
export async function sweep(agents: Agent[]): Promise<void> {
  const reg = await registration();
  if (reg?.getNotifications === undefined) return;
  const live = new Set(agents.filter((a) => LIVE.has(a.state)).map((a) => a.agentId));
  for (const n of await reg.getNotifications()) {
    if (n.tag !== "" && !live.has(n.tag)) n.close();
  }
}

/**
 * Sweep when the app comes forward, and whenever the agents move.
 *
 * The second trigger is not redundant: if you are already in the app when an
 * agent finishes, its stale alert should clear without needing a
 * background-and-return cycle.
 *
 * Keyed on the id-and-state SET rather than the array, the same way `App.tsx`
 * keys its cache eviction — a new array identity every render would sweep on
 * every render.
 */
export function useNotificationSweep(agents: Agent[]): void {
  const key = agents.map((a) => `${a.agentId}:${a.state}`).sort().join(" ");
  useEffect(() => {
    void sweep(agents);
    const onVisible = () => { if (!document.hidden) void sweep(agents); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [key]);
}
