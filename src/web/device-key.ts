import { hashEndpoint } from "@shared/device-key";

/**
 * This browser's device key, or null when it has no push subscription YET.
 *
 * Only a non-null result is cached. A subscription's endpoint is stable for
 * the life of the subscription, so once known it never needs recomputing —
 * but `null` is a statement about THIS MOMENT ("no subscription right now"),
 * not a fact about the browser. Latching it would mean: open paddock before
 * enabling push, and the very first `deviceKey()` call caches `null` forever,
 * so `sendViewing` keeps sending `deviceKey: null` on every heartbeat for the
 * rest of the tab's life even after Settings creates a subscription — and
 * `PresenceStore.viewers()` drops null keys, so `skip` is permanently empty,
 * `pushWithheld` is permanently false, and the whole feature goes quiet until
 * the page is reloaded. A phone can hold a tab open for days.
 *
 * Here rather than in `store.ts` so the store keeps knowing nothing about push
 * — it awaits an opaque string and sends it.
 */
let cached: string | null = null;

export async function deviceKey(): Promise<string | null> {
  if (cached !== null) return cached;
  const result = await compute();
  if (result !== null) cached = result;
  return result;
}

async function compute(): Promise<string | null> {
  const sw = globalThis.navigator?.serviceWorker;
  // Not an error: a browser without a service worker has no subscription to
  // identify, and a page with no subscription suppresses nothing.
  if (sw === undefined) return null;
  try {
    const reg = await sw.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub === null || sub === undefined ? null : await hashEndpoint(sub.endpoint);
  } catch (e) {
    console.info(`paddock: could not read the push subscription: ${(e as Error).message}`);
    return null;
  }
}

/** Forget what was cached — the unsubscribe path, and a test seam. Also
 *  called on a successful subscribe, even though that path only ever caches
 *  a non-null value, so enabling push takes effect immediately rather than
 *  waiting for whatever `deviceKey()` already returned this page load. */
export function resetDeviceKey(): void {
  cached = null;
}
