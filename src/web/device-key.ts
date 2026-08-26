import { hashEndpoint } from "@shared/device-key";

/**
 * This browser's device key, or null when it has no push subscription.
 *
 * Cached for the life of the page: a subscription's endpoint does not change
 * while the tab is open, and this is read on every heartbeat.
 *
 * Here rather than in `store.ts` so the store keeps knowing nothing about push
 * — it awaits an opaque string and sends it.
 */
let cached: string | null | undefined;

export async function deviceKey(): Promise<string | null> {
  if (cached !== undefined) return cached;
  cached = await compute();
  return cached;
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

/** Forget what was cached — the unsubscribe path, and a test seam. */
export function resetDeviceKey(): void {
  cached = undefined;
}
