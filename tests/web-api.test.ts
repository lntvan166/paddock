import { expect, test } from "bun:test";
import {
  answerWithKey, closeSpace, closeTab, fetchOutput, fetchPaneOutput, RequestFailed, renameAgent,
  renameSpace, renameTab, sendPaneKey, sendPaneText, type Fetch,
} from "@web/api";

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
  if (out.unchanged || "patch" in out) throw new Error("unreachable: stub returns a full screen");
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

// A pane with no agent is read through its own route, because the store cannot
// validate the id — that is the whole reason `/api/panes/:id/output` exists.
test("fetchPaneOutput POSTs to the pane route with an encoded id", async () => {
  const { fn, seen } = stubFetch(200, { lines: ["$ ls"], source: "recent_unwrapped" });
  const out = await fetchPaneOutput("w3:p1", fn);
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url).toBe("/api/panes/w3%3Ap1/output");
  expect(out.lines).toEqual(["$ ls"]);
});

// Same rule as every other read: a non-2xx body has no `lines`, so resolving
// with it would hand the caller an object TypeScript believes is a screen.
test("fetchPaneOutput rejects on a 404 with the server's detail", async () => {
  const { fn } = stubFetch(404, { ok: false, detail: "unknown pane" });
  await expect(fetchPaneOutput("w3:p1", fn)).rejects.toThrow(/unknown pane/);
});

// The 409 the route answers for a pane that HAS an agent. A refusal, but still
// a read: it must reject rather than resolve with a body shaped like output.
//
// The STATUS is the load-bearing part, not the message. `PaneTerminal` rides
// out a promotion by matching `err instanceof RequestFailed && err.status ===
// 409` and keeping the transcript on screen; any other error clears it and
// raises a banner carrying this internal route name. Asserting only the
// detail string would leave a change that dropped `status` — or threw a plain
// Error — green while the operator read "/api/agents/:id/output".
test("fetchPaneOutput rejects when the pane has an agent", async () => {
  const { fn } = stubFetch(409, {
    ok: false, detail: "this pane has an agent; use /api/agents/:id/output",
  });
  const err = await fetchPaneOutput("w3:p1", fn).then(
    () => { throw new Error("unreachable: a 409 must reject"); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RequestFailed);
  expect((err as RequestFailed).status).toBe(409);
  expect((err as RequestFailed).message).toMatch(/has an agent/);
});

// §16.3: the shell's own reply box points here, not at `sendText` — which is
// typed against an agent id and would 404 for a pane the store does not hold.
test("sendPaneText POSTs to the encoded pane route", async () => {
  const { fn, seen } = stubFetch(200, { ok: true });
  const res = await sendPaneText("w3:p1", "ls", false, fn);
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url).toBe("/api/panes/w3%3Ap1/text");
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ text: "ls", submit: false });
  expect(res.ok).toBe(true);
});

// `pane.send_text` does not submit, so `submit` is what separates typing a
// command from running one — and it has to reach the wire, not just the
// function. This is the assertion the shipped defect had nowhere to fail.
test("submit rides the body, so the route can run what was typed", async () => {
  const { fn, seen } = stubFetch(200, { ok: true });
  await sendPaneText("w3:p1", "ls", true, fn);
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ text: "ls", submit: true });
});

// Unlike the agent-side actions (`sendText`/`sendKey`), the pane route's
// success body carries no screen to fold a failure into — so a refusal
// rejects, exactly like every other read in this file, rather than resolving
// with an `ok: false` shape.
test("sendPaneText rejects on a non-2xx with the server's detail", async () => {
  const { fn } = stubFetch(409, {
    ok: false, detail: "this pane has an agent; use /api/panes/:id/text",
  });
  await expect(sendPaneText("w3:p1", "ls", false, fn)).rejects.toThrow(/has an agent/);
});

test("sendPaneKey POSTs to the encoded pane route", async () => {
  const { fn, seen } = stubFetch(200, { ok: true });
  const res = await sendPaneKey("w3:p1", "enter", fn);
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url).toBe("/api/panes/w3%3Ap1/key");
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ key: "enter" });
  expect(res.ok).toBe(true);
});

test("sendPaneKey rejects on a non-2xx with the server's detail", async () => {
  const { fn } = stubFetch(400, { ok: false, detail: "unsupported key: pageup" });
  await expect(sendPaneKey("w3:p1", "enter", fn)).rejects.toThrow(/unsupported key/);
});

// --- rename and close (§7, §10) ---------------------------------------

test("renameAgent POSTs to the encoded agent route with the new name", async () => {
  const { fn, seen } = stubFetch(200, { ok: true });
  const res = await renameAgent("w1:p1", "api-refactor", fn);
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url).toBe("/api/agents/w1%3Ap1/name");
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ name: "api-refactor" });
  expect(res.ok).toBe(true);
});

// The one real clear (§7.2, §17): `null` must reach the wire as the JSON
// literal `null`, not be stripped from the body or coerced to `undefined` —
// either of those would silently turn the clear into a no-op.
test("renameAgent sends {name: null} verbatim, not omitted or coerced", async () => {
  const { fn, seen } = stubFetch(200, { ok: true });
  await renameAgent("w1:p1", null, fn);
  const body = JSON.parse(String(seen[0]!.init.body)) as { name: unknown };
  expect(Object.keys(body)).toEqual(["name"]);
  expect(body.name).toBeNull();
});

test("renameAgent rejects on a non-2xx with the server's detail", async () => {
  const { fn } = stubFetch(404, { ok: false, detail: "unknown agent" });
  await expect(renameAgent("w1:p1", "api-refactor", fn)).rejects.toThrow(/unknown agent/);
});

test("renameTab POSTs to the encoded tab route with the new label", async () => {
  const { fn, seen } = stubFetch(200, { ok: true });
  const res = await renameTab("w1:t2", "docs-cleanup", fn);
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url).toBe("/api/tabs/w1%3At2/name");
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ label: "docs-cleanup" });
  expect(res.ok).toBe(true);
});

test("renameTab rejects on a non-2xx with the server's detail", async () => {
  const { fn } = stubFetch(400, { ok: false, detail: "label must be a non-empty string within the length limit" });
  await expect(renameTab("w1:t2", "", fn)).rejects.toThrow(/non-empty string/);
});

test("renameSpace POSTs to the encoded space route with the new label", async () => {
  const { fn, seen } = stubFetch(200, { ok: true });
  const res = await renameSpace("w1", "schema-migration", fn);
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url).toBe("/api/spaces/w1/name");
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ label: "schema-migration" });
  expect(res.ok).toBe(true);
});

test("renameSpace rejects on a non-2xx with the server's detail", async () => {
  const { fn } = stubFetch(404, { ok: false, detail: "unknown space" });
  await expect(renameSpace("w9", "schema-migration", fn)).rejects.toThrow(/unknown space/);
});

// Closing sends no body — there is nothing beyond the id in the path — so an
// empty object goes over the wire, the same as the other bodyless POSTs in
// this file (`fetchPrompt`, `acknowledge`).
test("closeTab POSTs an empty body to the encoded tab route", async () => {
  const { fn, seen } = stubFetch(200, { ok: true, tabId: "w1:t2", label: "docs-cleanup", paneCount: 2 });
  const res = await closeTab("w1:t2", fn);
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url).toBe("/api/tabs/w1%3At2/close");
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({});
  expect(res.ok).toBe(true);
  expect(res.tabId).toBe("w1:t2");
  expect(res.label).toBe("docs-cleanup");
  expect(res.paneCount).toBe(2);
});

test("closeTab rejects on a non-2xx with the server's detail", async () => {
  const { fn } = stubFetch(404, { ok: false, detail: "unknown tab" });
  await expect(closeTab("w1:t2", fn)).rejects.toThrow(/unknown tab/);
});

test("closeSpace POSTs an empty body to the encoded space route", async () => {
  const { fn, seen } = stubFetch(
    200, { ok: true, spaceId: "w1", label: "schema-migration", tabCount: 3, paneCount: 5 },
  );
  const res = await closeSpace("w1", fn);
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url).toBe("/api/spaces/w1/close");
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({});
  expect(res.ok).toBe(true);
  expect(res.spaceId).toBe("w1");
  expect(res.tabCount).toBe(3);
  expect(res.paneCount).toBe(5);
});

test("closeSpace rejects on a non-2xx with the server's detail", async () => {
  const { fn } = stubFetch(502, { ok: false, detail: "herdr socket unreachable" });
  await expect(closeSpace("w1", fn)).rejects.toThrow(/herdr socket unreachable/);
});
