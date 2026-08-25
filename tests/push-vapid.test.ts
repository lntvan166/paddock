import { expect, test } from "bun:test";
import {
  b64urlDecode, b64urlEncode, generateVapidKeys, vapidAuthorization,
} from "@server/push/vapid";

const T0 = 1_700_000_000_000;

test("base64url round-trips, with no padding and no + or /", () => {
  // The `+` and `/` of standard base64 are not URL-safe, and a padded value is
  // rejected by push services. Bytes chosen to force both substitutions.
  const bytes = new Uint8Array([251, 255, 190, 0, 1, 2]);
  const s = b64urlEncode(bytes);
  expect(s).not.toContain("+");
  expect(s).not.toContain("/");
  expect(s).not.toContain("=");
  expect([...b64urlDecode(s)]).toEqual([...bytes]);
});

test("a generated public key is an uncompressed P-256 point", async () => {
  // 65 bytes, leading 0x04. This is what goes to the browser as
  // applicationServerKey and into the `k=` parameter.
  const k = await generateVapidKeys();
  const raw = b64urlDecode(k.publicKey);
  expect(raw).toHaveLength(65);
  expect(raw[0]).toBe(0x04);
  expect(k.privateKey.kty).toBe("EC");
  expect(k.privateKey.crv).toBe("P-256");
  expect(typeof k.privateKey.d).toBe("string");
});

test("the header names the scheme, the token and the key", async () => {
  const keys = await generateVapidKeys();
  const h = await vapidAuthorization({
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    keys,
    now: () => T0,
  });
  expect(h).toStartWith("vapid t=");
  expect(h).toContain(", k=");
  expect(h).toContain(keys.publicKey);
});

const claimsOf = (h: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(
    b64urlDecode(h.split("t=")[1]!.split(",")[0]!.split(".")[1]!),
  )) as Record<string, unknown>;

test("aud is the endpoint's ORIGIN, not the endpoint", async () => {
  // Push services reject a token whose audience carries the path. This is the
  // single most common VAPID mistake after the signature format.
  const keys = await generateVapidKeys();
  const h = await vapidAuthorization({
    endpoint: "https://updates.push.services.mozilla.com/wpush/v2/gAAAA-long-path",
    keys,
    now: () => T0,
  });
  const claims = claimsOf(h);
  expect(claims.aud).toBe("https://updates.push.services.mozilla.com");
  expect(String(claims.aud)).not.toContain("wpush");
});

test("the token carries sub and an exp inside 24 hours", async () => {
  const keys = await generateVapidKeys();
  const h = await vapidAuthorization({
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123", keys, now: () => T0,
  });
  const claims = claimsOf(h);
  expect(claims.sub).toBe("https://github.com/lntvan166/paddock");
  expect(claims.exp as number).toBeGreaterThan(T0 / 1000);
  // RFC 8292 caps it at 24h; anything longer is rejected outright.
  expect(claims.exp as number).toBeLessThanOrEqual(T0 / 1000 + 86_400);
});

test("the header is ES256 and the signature is raw r||s, not DER", async () => {
  // THE bug this test exists for. WebCrypto emits raw r||s (64 bytes), which
  // is what RFC 8292 requires. Node's crypto emits DER, and code ported from a
  // Node example produces a signature every push service rejects while looking
  // entirely correct — a DER blob starts 0x30 and is 70-72 bytes.
  const keys = await generateVapidKeys();
  const h = await vapidAuthorization({
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123", keys, now: () => T0,
  });
  const jwt = h.split("t=")[1]!.split(",")[0]!;
  const [header, , signature] = jwt.split(".");
  expect(JSON.parse(new TextDecoder().decode(b64urlDecode(header!)))).toEqual({
    typ: "JWT", alg: "ES256",
  });
  expect(b64urlDecode(signature!)).toHaveLength(64);
});

test("the signature verifies against the public key", async () => {
  // Round-trip through WebCrypto: proves we signed the bytes we claim to have
  // signed, with the key we advertise in `k=`.
  const keys = await generateVapidKeys();
  const h = await vapidAuthorization({
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123", keys, now: () => T0,
  });
  const jwt = h.split("t=")[1]!.split(",")[0]!;
  const [header, payload, signature] = jwt.split(".");
  const pub = await crypto.subtle.importKey(
    "raw", b64urlDecode(keys.publicKey),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, pub,
    b64urlDecode(signature!), new TextEncoder().encode(`${header}.${payload}`),
  );
  expect(ok).toBe(true);
});
