import { expect, test } from "bun:test";
import { resolveSource } from "@server/herdr/actions";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { SpaceTree } from "@shared/types";

test("a shell always gets scrollback: it is on the normal screen and costs ~2ms", () => {
  expect(resolveSource(null, false)).toBe("recent_unwrapped");
  expect(resolveSource(null, true)).toBe("recent_unwrapped");
});

test("the agent rules are unchanged", () => {
  expect(resolveSource("idle", true)).toBe("recent_unwrapped");
  expect(resolveSource("idle", false)).toBe("visible");
  expect(resolveSource("working", true)).toBe("visible");
  expect(resolveSource("blocked", false)).toBe("visible");
});

// ── POST /api/panes/:id/output ──────────────────────────────────────────────
// Built with injected fakes, same convention as tests/spaces-route.test.ts —
// no server is started and the operator's real herdr is never touched.

const NOW = 1_700_000_000_000;

const TREE: SpaceTree = {
  readAt: NOW,
  spaces: [{
    spaceId: "w1", label: "example-space", tabCount: 1, paneCount: 2,
    tabs: [{
      tabId: "w1:t1", label: null,
      panes: [
        { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "api-refactor", cwd: "/srv/project", state: "working" },
        { paneId: "w1:p2", harness: null, name: null, title: null, cwd: "/srv/project", state: null },
      ],
    }],
  }],
};

/** `readPane` defaults to a plain success; both it and `readTree` are
 *  overridable per test so the route's try/catch can be exercised on either
 *  side of it. */
function harness(
  readTree?: () => Promise<SpaceTree>,
  readPane: (paneId: string) => Promise<{ lines: string[]; source: "recent_unwrapped" }> =
    async () => ({ lines: ["ok"], source: "recent_unwrapped" as const }),
) {
  return createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    readTree,
    actions: {
      async readOutput() { return { lines: [], source: "visible" as const }; },
      readPane,
      async readDetection() { return ""; },
      async sendOptionKey() {},
      async sendNavKey() {},
      async sendReply() {},
      async waitUntilUnblocked() {},
    },
    health: () => ({
      ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: true, lastEventAt: NOW,
      lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null,
      schemaWarning: null,
    }),
  });
}

const post = (app: any, path: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

test("reads a shell pane's output", async () => {
  const app = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p2/output");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ lines: ["ok"], source: "recent_unwrapped" });
});

test("an unknown pane 404s, distinctly from a herdr failure", async () => {
  const app = harness(async () => TREE);
  const res = await post(app, "/api/panes/nope/output");
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown pane");
});

test("a pane with an agent 409s, pointing at the agent route instead of reading it here", async () => {
  const app = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p1/output");
  expect(res.status).toBe(409);
  expect((await res.json()).detail).toContain("/api/agents/:id/output");
});

test("without a herdr reader the route 404s honestly, like /api/spaces in demo mode", async () => {
  const app = harness(undefined);
  const res = await post(app, "/api/panes/w1:p2/output");
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
});

test("a readTree failure surfaces as ok:false/502, never a bare 500", async () => {
  const app = harness(async () => { throw new Error("herdr socket refused"); });
  const res = await post(app, "/api/panes/w1:p2/output");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("herdr socket refused");
});

test("a readPane failure — e.g. the pane closed between validating and reading it — surfaces as ok:false/502", async () => {
  const app = harness(async () => TREE, async () => { throw new Error("pane_not_found"); });
  const res = await post(app, "/api/panes/w1:p2/output");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("pane_not_found");
});
