import { expect, test } from "bun:test";
import { tailnetHealth } from "@server/tailscale/lifecycle";
import { tailnetPortFrom } from "@server/tailscale/config";

const answer = (status: number, body: string): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

test("the tailnet listener counts as up only when its gate refuses an identity-less request", async () => {
  const gate = JSON.stringify({ ok: false, detail: "tailnet: no Tailscale identity on this request" });
  expect(await tailnetHealth(8789, answer(403, gate))).toBe(true);
});

test("anything else on the port is described, never taken for the listener", async () => {
  expect(await tailnetHealth(8789, answer(200, JSON.stringify({ ok: true, version: "1" }))))
    .toContain("HTTP 200");
  expect(await tailnetHealth(8789, answer(403, "forbidden"))).toContain("HTTP 403");
});

test("nothing listening is a reason, not a throw", async () => {
  const refused = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const why = await tailnetHealth(8789, refused);
  expect(why).toContain("127.0.0.1:8789");
  expect(why).toContain("ECONNREFUSED");
});

test("the probe is bounded: a listener that never answers cannot hang status", async () => {
  const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(new Error("timed out")));
  })) as unknown as typeof fetch;
  const t0 = Date.now();
  const why = await tailnetHealth(8789, hang, 50);
  expect(Date.now() - t0).toBeLessThan(1_000);
  expect(why).toContain("timed out");
});

test("the tailnet port is PADDOCK_TAILNET_PORT, default 8789", () => {
  expect(tailnetPortFrom({})).toBe(8789);
  expect(tailnetPortFrom({ PADDOCK_TAILNET_PORT: "9001" })).toBe(9001);
});
