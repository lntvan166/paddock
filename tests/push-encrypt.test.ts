import { expect, test } from "bun:test";
import { b64urlDecode, b64urlEncode } from "@server/push/vapid";
import { encryptPayload } from "@server/push/encrypt";

// RFC 8291 §5, "Push Message Encryption Example". Every value below is
// transcribed from the RFC. VERIFY THEM AGAINST THE RFC TEXT before trusting a
// failure: if the known-answer test fails while the round trip passes, suspect
// this transcription before suspecting the implementation.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  /**
   * The RFC's published result: the complete body, base64url, for exactly the
   * inputs above. THIS is the anchor to the standard.
   *
   * Without it the "RFC vector" test only proves that our encrypt and our
   * decrypt agree with each other, which a SYMMETRICALLY wrong construction
   * satisfies too — the same mistyped info string on both sides cancels out.
   * Comparing against a ciphertext this code did not produce is the only thing
   * that rules that out.
   */
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** Rebuild a P-256 keypair from the RFC's raw private scalar and public point. */
async function keyPairFrom(rawPublic: string, rawPrivate: string): Promise<CryptoKeyPair> {
  const pub = b64urlDecode(rawPublic);
  const jwk: JsonWebKey = {
    kty: "EC", crv: "P-256", ext: true,
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: rawPrivate,
  };
  const privateKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, [],
  );
  return { privateKey, publicKey };
}

/**
 * An INDEPENDENT decryption, written from the RFC rather than by calling back
 * into the implementation. It is what makes the round trip meaningful: if
 * `encrypt.ts` and this disagree, one of them is wrong, and neither can hide
 * the error by making the same mistake in the same place.
 */
async function decrypt(
  body: Uint8Array, uaPublic: string, uaPrivate: string, authSecret: string,
): Promise<string> {
  // `slice` widens to Uint8Array<ArrayBufferLike>, which WebCrypto's
  // BufferSource rejects because that type admits SharedArrayBuffer. Copy into
  // a plain ArrayBuffer once, here, rather than casting at six call sites.
  const narrow = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(new ArrayBuffer(u.length));
    out.set(u);
    return out;
  };
  const salt = narrow(body.slice(0, 16));
  const idlen = body[20]!;
  const asPublic = narrow(body.slice(21, 21 + idlen));
  const ciphertext = narrow(body.slice(21 + idlen));

  const ua = await keyPairFrom(uaPublic, uaPrivate);
  const asKey = await crypto.subtle.importKey(
    "raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const shared: Uint8Array<ArrayBuffer> = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: asKey }, ua.privateKey, 256,
  ));

  const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  const hkdf = async (
    ikm: Uint8Array<ArrayBuffer>, s: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>, len: number,
  ): Promise<Uint8Array<ArrayBuffer>> => {
    const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: s, info }, k, len * 8,
    ));
  };
  const enc = new TextEncoder();
  const keyInfo = cat(enc.encode("WebPush: info"), new Uint8Array([0]), b64urlDecode(uaPublic), asPublic);
  const ikm = await hkdf(shared, b64urlDecode(authSecret), keyInfo, 32);
  const cek = await hkdf(ikm, salt, cat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, salt, cat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce }, aes, ciphertext,
  ));
  // Strip RFC 8188's 0x02 last-record delimiter.
  return new TextDecoder().decode(plain.slice(0, plain.length - 1));
}

test("the framing header is exactly as RFC 8188 lays it out", async () => {
  const body = await encryptPayload({
    plaintext: new TextEncoder().encode("hi"),
    p256dh: RFC.uaPublic, auth: RFC.authSecret,
  });
  expect(body.length).toBeGreaterThan(21 + 65);
  // salt(16) || rs(4, big-endian) || idlen(1) || as_public(65) || ciphertext
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  expect(rs).toBe(4096);
  expect(body[20]).toBe(65);
  expect(body[21]).toBe(0x04); // uncompressed point
});

test("a fresh ephemeral key and salt are used for every message", async () => {
  // Reusing either across messages leaks: the same key stream twice under
  // AES-GCM is catastrophic, and a fixed ephemeral key defeats the point of
  // having one.
  const one = await encryptPayload({
    plaintext: new TextEncoder().encode("hi"), p256dh: RFC.uaPublic, auth: RFC.authSecret,
  });
  const two = await encryptPayload({
    plaintext: new TextEncoder().encode("hi"), p256dh: RFC.uaPublic, auth: RFC.authSecret,
  });
  expect(b64urlEncode(one.slice(0, 16))).not.toBe(b64urlEncode(two.slice(0, 16)));   // salt
  expect(b64urlEncode(one.slice(21, 86))).not.toBe(b64urlEncode(two.slice(21, 86))); // as_public
});

// STRATEGY ONE: a round trip against an independent decryption. Catches every
// asymmetric error — wrong info order, wrong salt, wrong nonce, bad padding.
test("what we encrypt, the subscription's own key decrypts", async () => {
  const message = JSON.stringify({ name: "api-refactor", state: "blocked", agentId: "a1b2c3" });
  const body = await encryptPayload({
    plaintext: new TextEncoder().encode(message),
    p256dh: RFC.uaPublic, auth: RFC.authSecret,
  });
  expect(await decrypt(body, RFC.uaPublic, RFC.uaPrivate, RFC.authSecret)).toBe(message);
});

test("a payload the size of a real notification round-trips", async () => {
  const message = JSON.stringify({
    name: "schema-migration", state: "done", agentId: "0123456789abcdef",
  });
  const body = await encryptPayload({
    plaintext: new TextEncoder().encode(message),
    p256dh: RFC.uaPublic, auth: RFC.authSecret,
  });
  expect(await decrypt(body, RFC.uaPublic, RFC.uaPrivate, RFC.authSecret)).toBe(message);
});

// STRATEGY TWO: the anchor to the standard. A round trip alone would pass a
// SYMMETRICALLY wrong construction — a mistyped info string used identically
// on both sides. Pinning the RFC's own inputs to the RFC's own plaintext is
// what rules that out.
test("the RFC's own example decrypts to the RFC's own plaintext", async () => {
  const body = await encryptPayload({
    plaintext: new TextEncoder().encode(RFC.plaintext),
    p256dh: RFC.uaPublic,
    auth: RFC.authSecret,
    salt: b64urlDecode(RFC.salt),
    asKeyPair: await keyPairFrom(RFC.asPublic, RFC.asPrivate),
  });
  // THE assertion. Every byte of the RFC's published result, from the RFC's
  // published inputs — a ciphertext this code did not produce and cannot have
  // agreed with by making a matching mistake. A failure here means the
  // derivation diverged from the standard, however self-consistent it looks.
  expect(b64urlEncode(body)).toBe(RFC.body);

  // The framing, called out separately so a failure says WHICH part moved.
  expect(b64urlEncode(body.slice(0, 16))).toBe(RFC.salt);
  expect(b64urlEncode(body.slice(21, 86))).toBe(RFC.asPublic);
  // And it decrypts to the example's plaintext.
  expect(await decrypt(body, RFC.uaPublic, RFC.uaPrivate, RFC.authSecret)).toBe(RFC.plaintext);
});
