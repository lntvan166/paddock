import { expect, test } from "bun:test";
import { generateVapidKeys } from "@server/push/vapid";
import { sendPush } from "@server/push/send";

const TARGET = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};
const PAYLOAD = JSON.stringify({ name: "api-refactor", state: "blocked", agentId: "a1b2c3" });

const stub = (res: Response | (() => never)) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (typeof res === "function") res();
    return res;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

test("a 201 is success", async () => {
  const keys = await generateVapidKeys();
  const s = stub(new Response(null, { status: 201 }));
  const out = await sendPush({ target: TARGET, payload: PAYLOAD, keys, fetchImpl: s.fetchImpl });
  expect(out).toEqual({ kind: "ok" });
});

test("the request carries the encoding, the TTL and the VAPID header", async () => {
  const keys = await generateVapidKeys();
  const s = stub(new Response(null, { status: 201 }));
  await sendPush({ target: TARGET, payload: PAYLOAD, keys, fetchImpl: s.fetchImpl });
  const h = new Headers(s.calls[0]!.init.headers as HeadersInit);
  expect(s.calls[0]!.url).toBe(TARGET.endpoint);
  expect(s.calls[0]!.init.method).toBe("POST");
  expect(h.get("content-encoding")).toBe("aes128gcm");
  expect(h.get("content-type")).toBe("application/octet-stream");
  expect(h.get("ttl")).toBe("3600");
  expect(h.get("authorization")).toStartWith("vapid t=");
});

test("the body is the encrypted payload, not the plaintext", async () => {
  const keys = await generateVapidKeys();
  const s = stub(new Response(null, { status: 201 }));
  await sendPush({ target: TARGET, payload: PAYLOAD, keys, fetchImpl: s.fetchImpl });
  const body = s.calls[0]!.init.body as Uint8Array;
  expect(body).toBeInstanceOf(Uint8Array);
  expect(new TextDecoder().decode(body)).not.toContain("api-refactor");
  expect(body[20]).toBe(65); // the RFC 8188 idlen field
});

// 404 and 410 are the push service stating the subscription no longer exists.
test("404 and 410 mean gone", async () => {
  const keys = await generateVapidKeys();
  for (const status of [404, 410]) {
    const s = stub(new Response(null, { status }));
    const out = await sendPush({ target: TARGET, payload: PAYLOAD, keys, fetchImpl: s.fetchImpl });
    expect(out).toEqual({ kind: "gone" });
  }
});

// THE test that earns its place. Pruning on any failure is how one bad
// afternoon quietly unsubscribes every device the operator owns.
test("rate limits, server errors and network failures KEEP the subscription", async () => {
  const keys = await generateVapidKeys();
  for (const status of [400, 413, 429, 500, 502, 503]) {
    const s = stub(new Response("nope", { status }));
    const out = await sendPush({ target: TARGET, payload: PAYLOAD, keys, fetchImpl: s.fetchImpl });
    expect(out.kind).toBe("failed");
    expect(out.kind === "failed" && out.detail).toContain(String(status));
  }
  const thrown = stub(() => { throw new Error("connection reset"); });
  const out = await sendPush({ target: TARGET, payload: PAYLOAD, keys, fetchImpl: thrown.fetchImpl });
  expect(out.kind).toBe("failed");
  expect(out.kind === "failed" && out.detail).toContain("connection reset");
});

test("a hung push service does not leak a pending request for ever", async () => {
  const keys = await generateVapidKeys();
  const fetchImpl = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
    init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
  })) as unknown as typeof fetch;
  const out = await sendPush({
    target: TARGET, payload: PAYLOAD, keys, fetchImpl, timeoutMs: 10,
  });
  expect(out.kind).toBe("failed");
});
