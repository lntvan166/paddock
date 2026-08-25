import { encryptPayload } from "@server/push/encrypt";
import { vapidAuthorization, type VapidKeys } from "@server/push/vapid";

/**
 * One HTTPS POST. Transport only — every policy decision lives in
 * `notify/notifier.ts`, exactly as `notify/telegram.ts` says of itself.
 */

/**
 * How long a push service holds a message for a phone that is offline.
 *
 * A "needs you" arriving six hours later is noise; a phone in a pocket through
 * a meeting should still get it. One hour is the compromise, and it is a number
 * to revisit against real use rather than a derived constant.
 */
const TTL_S = 3600;

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * `gone` is the ONLY outcome that removes a subscription.
 *
 * A push service answering 404 or 410 is stating that the subscription no
 * longer exists. Everything else keeps it: 429 is rate limiting, 500 is their
 * problem, and a network error is probably ours. Pruning on any failure is how
 * one bad afternoon unsubscribes every device the operator owns.
 */
export type PushOutcome =
  | { kind: "ok" }
  | { kind: "gone" }
  | { kind: "failed"; detail: string };

export async function sendPush(o: {
  target: PushTarget;
  payload: string;
  keys: VapidKeys;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}): Promise<PushOutcome> {
  const f = o.fetchImpl ?? fetch;
  const ac = new AbortController();
  // Unbounded, this leaks one pending request per notification against a black
  // hole — the same reason `telegram.ts` carries a timeout.
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 10_000);
  try {
    const body = await encryptPayload({
      plaintext: new TextEncoder().encode(o.payload),
      p256dh: o.target.p256dh,
      auth: o.target.auth,
    });
    const authorization = await vapidAuthorization({
      endpoint: o.target.endpoint, keys: o.keys, now: o.now,
    });
    const res = await f(o.target.endpoint, {
      method: "POST",
      headers: {
        authorization,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(TTL_S),
      },
      body,
      signal: ac.signal,
    });
    if (res.status === 404 || res.status === 410) return { kind: "gone" };
    if (!res.ok) {
      // The status is named, not swallowed: an operator who cannot tell a 429
      // from a 500 has been told nothing they can act on.
      return { kind: "failed", detail: `push rejected (HTTP ${res.status})` };
    }
    return { kind: "ok" };
  } catch (e) {
    return { kind: "failed", detail: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
