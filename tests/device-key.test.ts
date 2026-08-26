import { expect, test } from "bun:test";
import { hashEndpoint } from "@shared/device-key";

const ENDPOINT = "https://push.example.com/send/abc123";

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
