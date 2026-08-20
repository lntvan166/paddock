import { expect, test } from "bun:test";
import type { StateCheck } from "@server/lifecycle/state";
import { preflight } from "@server/tunnel/preflight";

const RUNNING: StateCheck = {
  kind: "running",
  state: { pid: 4242, args: "paddock", port: 8787, version: "0.6.1", startedAt: 0 },
};

type Opts = Parameters<typeof preflight>[0];
const opts = (over: Partial<Opts> = {}): Opts => ({
  dir: "/tmp/paddock-preflight-fixture",
  platform: "linux",
  which: () => "/somewhere/cloudflared",
  check: async () => ({ kind: "none" }),
  ...over,
});

test("all three clear reports the binary's path", async () => {
  expect(await preflight(opts())).toEqual({ ok: true, bin: "/somewhere/cloudflared" });
});

test("a running detached instance is refused, and the reason is named", async () => {
  const r = await preflight(opts({ check: async () => RUNNING }));
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  // The hazard is two notifiers, not a port conflict. Say which.
  expect(r.message).toMatch(/notif/i);
  expect(r.message).toContain("paddock stop");
  expect(r.message).toContain("4242");
});

test("a missing cloudflared is refused with the platform's install line", async () => {
  const r = await preflight(opts({ which: () => null, platform: "darwin" }));
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.message).toContain("brew install cloudflared");
  expect(r.message).toContain("developers.cloudflare.com");
});

test("the detached check runs before the binary check", async () => {
  // Cheapest first, and the more actionable message wins: being told to
  // install cloudflared, then told to stop paddock, is two round trips.
  const r = await preflight(opts({ check: async () => RUNNING, which: () => null }));
  if (r.ok) throw new Error("unreachable");
  expect(r.message).toContain("paddock stop");
  expect(r.message).not.toContain("brew");
});

test("a stale or mismatched state file does not block a tunnel", async () => {
  expect((await preflight(opts({
    check: async () => ({ kind: "stale", state: RUNNING.state }),
  }))).ok).toBe(true);
  expect((await preflight(opts({
    check: async () => ({ kind: "mismatch", state: RUNNING.state, actual: null }),
  }))).ok).toBe(true);
});

test("an unreadable state file does not block a tunnel, but is reported", async () => {
  const lines: string[] = [];
  const r = await preflight(opts({
    check: async () => ({ kind: "unreadable", error: "EACCES" }),
    log: (l) => lines.push(l),
  }));
  expect(r.ok).toBe(true);
  // Never swallowed: the operator learns the file could not be read.
  expect(lines.join("\n")).toContain("EACCES");
});
