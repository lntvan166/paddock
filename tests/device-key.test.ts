import { afterEach, expect, test } from "bun:test";
import { hashEndpoint } from "@shared/device-key";
import { deviceKey, resetDeviceKey } from "@web/device-key";

const ENDPOINT = "https://push.example.com/send/abc123";

/**
 * Fake `navigator.serviceWorker` whose `getSubscription()` answer can change
 * between calls — the shape of a subscription created mid-session, from
 * Settings, after the tab already loaded and already called `deviceKey()`
 * once. Same install-on-the-existing-navigator pattern as
 * `notification-sweep.test.ts`'s `fakeSw`, because Bun ships a navigator with
 * no service worker at all.
 */
function fakeSw(subscriptions: (null | { endpoint: string })[]) {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, "serviceWorker");
  let call = 0;
  const registration = {
    pushManager: {
      getSubscription: async () => subscriptions[Math.min(call++, subscriptions.length - 1)] ?? null,
    },
  };
  Object.defineProperty(nav, "serviceWorker", {
    value: { getRegistration: async () => registration },
    configurable: true, writable: true,
  });
  return () => {
    if (had) Object.defineProperty(nav, "serviceWorker", had);
    else delete nav.serviceWorker;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  resetDeviceKey();
});

test("a subscription created after the first deviceKey() call is picked up", async () => {
  // The bug: `deviceKey()` used to cache its result INCLUDING null, so the
  // ordinary first-run path — open paddock, then enable push in Settings —
  // latched `null` forever and the whole presence feature went quiet until
  // the page was reloaded. Only a positive result may be cached; `null` is a
  // statement about this moment, not a fact about the browser.
  restore = fakeSw([null, { endpoint: ENDPOINT }]);
  expect(await deviceKey()).toBeNull();
  expect(await deviceKey()).toBe(await hashEndpoint(ENDPOINT));
});

test("once a subscription is found, its hash is cached rather than recomputed", async () => {
  restore = fakeSw([{ endpoint: ENDPOINT }, { endpoint: `${ENDPOINT}-different` }]);
  const first = await deviceKey();
  const second = await deviceKey();
  expect(first).toBe(second);
  expect(first).toBe(await hashEndpoint(ENDPOINT));
});

test("resetDeviceKey() forgets a cached hash, for the unsubscribe path", async () => {
  restore = fakeSw([{ endpoint: ENDPOINT }, null]);
  expect(await deviceKey()).toBe(await hashEndpoint(ENDPOINT));
  resetDeviceKey();
  expect(await deviceKey()).toBeNull();
});

test("the key is unpadded base64url", async () => {
  // It travels in a JSON frame and is compared as a string. base64url is what
  // every other key in this codebase uses (VAPID, p256dh, auth), and a second
  // encoding is a second thing to get wrong.
  expect(await hashEndpoint(ENDPOINT)).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("the same endpoint always hashes the same, and a different one differs", async () => {
  // Stability is the whole contract: the browser hashes its endpoint, the
  // server hashes the stored copy of the same endpoint, and the two must meet.
  expect(await hashEndpoint(ENDPOINT)).toBe(await hashEndpoint(ENDPOINT));
  expect(await hashEndpoint(ENDPOINT)).not.toBe(await hashEndpoint(`${ENDPOINT}x`));
});

test("the key does not contain the endpoint", async () => {
  // An endpoint is a bearer credential for pushing to that device. The hash
  // exists so the credential is not the thing on the wire.
  const k = await hashEndpoint(ENDPOINT);
  expect(k).not.toContain("push.example.com");
  expect(k).not.toContain("abc123");
});
