import { expect, test } from "bun:test";
import { answerWithKey, fetchOutput, type Fetch } from "@web/api";

// Typed as the real `fetch`, so call sites need no `as any`.
//
// They previously did, and that cast silently absorbed a change to
// `fetchOutput`'s signature: the stub was being passed as the parameter that
// had become `scrollback`, `tsc` accepted it, and the break only surfaced at
// runtime as "fetch() URL is invalid". A cast in a test disables the check the
// test exists to provide.
function stubFetch(status: number, body: object) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fn: Fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
  };
  return { fn, seen };
}

test("fetchOutput POSTs and returns the parsed body", async () => {
  const { fn, seen } = stubFetch(200, { lines: ["a"], source: "visible" });
  const out = await fetchOutput("w1:p1", 40, false, null, fn);
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url).toBe("/api/agents/w1%3Ap1/output");
  expect(out.unchanged).toBeFalsy();
  if (out.unchanged) throw new Error("unreachable: stub returns a screen");
  expect(out.lines).toEqual(["a"]);
});

// A refusal is information the operator needs, not an exception to swallow.
test("a refusal surfaces ok:false with the server's reason", async () => {
  const { fn } = stubFetch(409, { ok: false, detail: "agent is working, no longer blocked" });
  const res = await answerWithKey("w1:p1", "1", fn);
  expect(res.ok).toBe(false);
  expect(res.detail).toContain("no longer blocked");
});

test("a network failure becomes an ActionResult, not a throw", async () => {
  const fn = async () => { throw new Error("offline"); };
  const res = await answerWithKey("w1:p1", "1", fn);
  expect(res.ok).toBe(false);
  expect(res.detail).toContain("offline");
});

// A read must not resolve with a value whose type is a lie: a non-2xx body
// like { ok: false, detail: "unknown agent" } is valid JSON but has no
// `lines` — resolving with it would hand the caller an object TypeScript
// believes has `lines` but doesn't. It must reject instead, carrying the
// server's reason.
test("fetchOutput rejects on a 404 with the server's detail in the message", async () => {
  const { fn } = stubFetch(404, { ok: false, detail: "unknown agent" });
  await expect(fetchOutput("w1:p1", 40, false, null, fn)).rejects.toThrow(/unknown agent/);
});

test("fetchOutput rejects on a 502 with the server's detail in the message", async () => {
  const { fn } = stubFetch(502, { ok: false, detail: "herdr socket unreachable" });
  await expect(fetchOutput("w1:p1", 40, false, null, fn)).rejects.toThrow(/herdr socket unreachable/);
});

// Pins the asymmetry deliberately: reads reject on non-2xx, but actions must
// keep resolving with the server's real detail. A future refactor that
// "unifies" the two paths should break this test rather than silently
// destroying the refusal message.
test("answerWithKey still resolves (not rejects) with the server's detail on a 409", async () => {
  const { fn } = stubFetch(409, { ok: false, detail: "agent is working, no longer blocked" });
  const res = await answerWithKey("w1:p1", "1", fn);
  expect(res.ok).toBe(false);
  expect(res.detail).toContain("no longer blocked");
});
