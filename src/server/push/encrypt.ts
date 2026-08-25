import { b64urlDecode } from "@server/push/vapid";

/**
 * RFC 8291 payload encryption, in the `aes128gcm` content coding of RFC 8188.
 *
 * This is the one piece of paddock that cannot be checked by reading it, which
 * is why `tests/push-encrypt.test.ts` verifies it twice and in two independent
 * ways: a round trip against a decryption written separately from the RFC, and
 * a known-answer test pinned to the RFC's own worked example. The round trip
 * alone would pass a symmetrically wrong construction; the vector alone would
 * not exercise fresh randomness.
 *
 * The payload is encrypted END TO END to the browser — the push service cannot
 * read it. That is why `notify/notifier.ts`'s content-minimalism rationale does
 * not transfer, and why the design records a different reason for keeping the
 * same restraint: a notification renders on a lock screen.
 */

/** One record, big-endian. A `{name, state, agentId}` payload cannot approach
 *  4096 bytes, so multi-record framing would be machinery for an unreachable
 *  case. */
const RECORD_SIZE = 4096;

const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

async function hkdf(
  ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>, len: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8,
  ));
}

export interface EncryptOpts {
  plaintext: Uint8Array;
  /** The subscription's `keys.p256dh`: an uncompressed P-256 point, base64url. */
  p256dh: string;
  /** The subscription's `keys.auth`: 16 bytes, base64url. */
  auth: string;
  /** Test-only. Production omits both and gets fresh randomness per message,
   *  which is not optional — a reused salt or ephemeral key under AES-GCM is a
   *  catastrophic failure, not a degraded one. */
  salt?: Uint8Array<ArrayBuffer>;
  asKeyPair?: CryptoKeyPair;
}

export async function encryptPayload(o: EncryptOpts): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const as = o.asKeyPair ?? await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );

  const uaPublicRaw = b64urlDecode(o.p256dh);
  const uaPublic = await crypto.subtle.importKey(
    "raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));

  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublic }, as.privateKey, 256,
  ));

  // RFC 8291 §3.4. The auth secret is the SALT of this derivation and the ECDH
  // output is the IKM — the reverse of the intuition, and getting it the other
  // way round produces a body that fails to decrypt with no useful signal.
  const keyInfo = cat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(shared, b64urlDecode(o.auth), keyInfo, 32);

  const cek = await hkdf(ikm, salt, cat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, salt, cat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 is RFC 8188's LAST-record delimiter. 0x01 would say "more records
  // follow" and the browser would wait for one that never comes.
  const padded = cat(o.plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, aes, padded,
  ));

  const rs = new Uint8Array(new ArrayBuffer(4));
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);
  return cat(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}
