import type { AgentState } from "@shared/types";
import type { PushOutcome, PushTarget } from "@server/push/send";
import type { PushStore } from "@server/push/store";
import type { VapidKeys } from "@server/push/vapid";

/**
 * Composition-root wiring that needs testing without booting a server.
 *
 * A sibling of `fanOut` in `notify/notifier.ts`, and here for the same reason
 * that one is exported: `index.ts` has a top-level `await` and binds ports, so
 * a test that imported it to reach this function would start a paddock.
 */

/**
 * Fan one notification out to every subscribed device, pruning only the ones
 * the push service says are gone.
 *
 * Returns null when there is no keypair — an unreadable `push.json` disables
 * push, and a sender that fails once per notification for ever is not a
 * degraded feature, it is a log full of noise.
 */
export function buildPushSender(
  store: Pick<PushStore, "keys" | "list" | "remove">,
  send: (target: PushTarget, keys: VapidKeys, payload: string) => Promise<PushOutcome>,
): ((p: { name: string; state: AgentState; agentId: string }) => Promise<void>) | null {
  const keys = store.keys();
  if (keys === null) return null;
  return async (payload) => {
    const body = JSON.stringify(payload);
    // Sequential, not Promise.all: `remove` rewrites the store's list, and a
    // concurrent prune racing another send's read is a subscription lost to a
    // write that never saw it.
    for (const target of store.list()) {
      const out = await send(target, keys, body);
      if (out.kind === "gone") {
        await store.remove(target.endpoint);
      } else if (out.kind === "failed") {
        // The ORIGIN, never the full endpoint: an endpoint is a bearer
        // credential for sending to that device, and this line goes to a log.
        // Reported rather than thrown, so one broken device does not stop the
        // ones after it.
        console.info(`paddock: push to ${new URL(target.endpoint).origin} failed: ${out.detail}`);
      }
    }
  };
}
