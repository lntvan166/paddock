import type { AgentState } from "@shared/types";
import type { Delta } from "@server/state/store";
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
): ((p: {
  name: string; state: AgentState; agentId: string; skipDeviceKeys: Set<string>;
}) => Promise<void>) | null {
  const keys = store.keys();
  if (keys === null) return null;
  return async (payload) => {
    // Destructured OFF, not merely unused: `content` is what gets encrypted,
    // and a push payload is `{name, state, agentId}` and nothing else because
    // it renders on a lock screen.
    const { skipDeviceKeys, ...content } = payload;
    const body = JSON.stringify(content);
    // Sequential, not Promise.all: `remove` rewrites the store's list, and a
    // concurrent prune racing another send's read is a subscription lost to a
    // write that never saw it.
    for (const target of store.list()) {
      // Already showing this agent on that device. Withheld here rather than
      // filtered upstream so the notifier states the policy and the transport
      // applies it — `notifier.ts` owns every decision, this file owns none.
      if (skipDeviceKeys.has(target.deviceKey)) continue;
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

/**
 * Where a delta goes: the browsers, and the notifier when there is one.
 *
 * WHY THIS IS A FUNCTION AND NOT TWO LINES IN `index.ts`. It used to be two
 * lines, and they were differently shaped:
 *
 *     onDelta: fanOut(hub, notifier)       // herdr
 *     onDelta: (d) => hub.queue(d)         // --demo
 *
 * An edit that made the first look like the second would pass the whole suite.
 * The browser fan-out keeps working, nothing user-visible breaks, and the
 * notifier simply never sees another delta again — so paddock stops telling
 * anyone their agent is blocked, which is the entire reason it exists.
 * `docs/roadmap.md` recorded that as a gap; `build-id.ts`'s `indexHtmlFor`
 * records the same shape of defect actually happening, silently, for months.
 *
 * A guard could not just forbid the hub-only shape, because `--demo` wants it:
 * a demo must not fire real Telegram messages about synthetic agents. So both
 * modes call THIS, and the demo says so by passing `null` — the bypass becomes
 * an argument a reader can see rather than a line that differs by omission.
 * `null` is required, not optional, so a caller cannot forget the decision.
 *
 * The hub goes first. A notifier settling a trigger or awaiting a push must
 * never sit between a delta and the screen showing it.
 */
export function deltaSink(
  hub: { queue: (d: Delta) => void },
  notifier: { observe: (d: Delta) => void } | null,
): (d: Delta) => void {
  return (d) => {
    hub.queue(d);
    notifier?.observe(d);
  };
}
