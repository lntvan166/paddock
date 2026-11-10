import { expect, test } from "bun:test";
import { markOpened } from "@web/api";

test("markOpened POSTs once with no payload in the URL", async () => {
  const calls: [string, RequestInit | undefined][] = [];
  const f = (async (u: string, init?: RequestInit) => {
    calls.push([u, init]);
    return new Response(null, { status: 204 });
  }) as never;
  expect(await markOpened("core:t1", f)).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe("/api/agents/core%3At1/opened");
  expect(calls[0]![1]!.method).toBe("POST");
});

test("a refused open resolves with the reason instead of throwing", async () => {
  const f = (async () =>
    new Response(JSON.stringify({ ok: false, detail: "this is the demo" }), { status: 409 })) as never;
  expect(await markOpened("core:t1", f)).toEqual({ ok: false, detail: "this is the demo" });
});
