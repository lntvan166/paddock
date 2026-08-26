/**
 * One device's identity for suppression, derived from its push endpoint.
 *
 * In `shared/` because BOTH sides compute it and the two results must be equal
 * for the feature to work at all: the browser hashes the endpoint it holds,
 * the server hashes the copy it stored, and a second implementation is a
 * second thing to drift. `quick-tunnel.ts` is the precedent for a shared pure
 * function living beside the shared types.
 *
 * A HASH rather than the endpoint itself. An endpoint is a bearer credential
 * for pushing to that device: it is already stored once, in `push.json`, and
 * there is no reason to put it on a second wire or to create a second value
 * that must never reach a log line. `index-wiring.ts` already logs only an
 * endpoint's origin for the same reason.
 *
 * `crypto.subtle` needs a secure context, which the service worker that
 * produced the subscription already required — so this adds no constraint that
 * push did not already impose.
 */
export async function hashEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return b64url(new Uint8Array(digest));
}

/** Unpadded base64url, matching every other key in this codebase. */
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
