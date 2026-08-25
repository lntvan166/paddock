/**
 * The RFC 8292 `Authorization` header: proof that this server, and not
 * something that copied a subscription off a phone, is sending the push.
 *
 * Transport-adjacent and policy-free, like `notify/telegram.ts` — everything
 * about WHEN to send lives in `notify/notifier.ts`.
 */

/**
 * RFC 8292 §2.1 accepts a `mailto:` or an `https:` URL, and requires one.
 * paddock sends the project URL: there is no operator email to assume, and
 * CLAUDE.md forbids putting one in a tracked file.
 */
const SUB = "https://github.com/lntvan166/paddock";

/** Twelve hours. RFC 8292 caps `exp` at 24h from issue; half that leaves room
 *  for a clock skewed in either direction without ever exceeding the cap. */
const EXPIRY_S = 43_200;

export interface VapidKeys {
  /** base64url, uncompressed point, 65 bytes. Goes in `k=` and to the browser
   *  as `applicationServerKey`. */
  publicKey: string;
  /** JWK. Never leaves the server, and never enters a settings view. */
  privateKey: JsonWebKey;
}

/**
 * base64url WITHOUT padding.
 *
 * `+` and `/` are not URL-safe and `=` is rejected outright by push services,
 * so all three are handled here rather than at each call site — a single
 * missed replacement produces a token that is refused with no useful detail.
 */
export function b64urlEncode(b: Uint8Array): string {
  let bin = "";
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * `Uint8Array<ArrayBuffer>` and not a bare `Uint8Array`, which under this
 * TypeScript defaults to `Uint8Array<ArrayBufferLike>` — a type WebCrypto's
 * `BufferSource` will not accept, because `ArrayBufferLike` admits
 * `SharedArrayBuffer`. Narrowing here rather than at each call site means
 * every consumer can hand the result straight to `crypto.subtle`.
 */
export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * An ECDSA P-256 keypair. NOT reusable for the payload encryption, which needs
 * ECDH — WebCrypto binds a key to one algorithm, and the two are separate by
 * design anyway: the VAPID key is long-lived and identifies this server, while
 * encryption uses a fresh ephemeral key per message.
 */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: b64urlEncode(raw), privateKey: jwk };
}

export async function vapidAuthorization(o: {
  endpoint: string;
  keys: VapidKeys;
  now?: () => number;
}): Promise<string> {
  const now = (o.now ?? Date.now)();
  const enc = new TextEncoder();
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // The ORIGIN, never the full endpoint. A push service rejects a token whose
  // audience carries the path, and the rejection says nothing useful.
  const claims = {
    aud: new URL(o.endpoint).origin,
    exp: Math.floor(now / 1000) + EXPIRY_S,
    sub: SUB,
  };
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "jwk", o.keys.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  // WebCrypto emits raw r||s — 64 bytes — which is exactly what RFC 8292
  // wants. Node's `crypto` emits DER instead, so a signature lifted from a
  // Node example is 70-72 bytes starting 0x30 and is refused by every push
  // service while looking entirely correct. Do not "fix" this by wrapping it.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput),
  ));

  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${o.keys.publicKey}`;
}
