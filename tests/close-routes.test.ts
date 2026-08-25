import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent, SpaceTree } from "@shared/types";

// ── POST /api/tabs/:id/close, POST /api/spaces/:id/close
// Built with injected fakes, same convention as tests/rename-routes.test.ts —
// no server is started and the operator's real herdr is never touched.
//
// paddock's first destructive action: closing a tab or a space kills its
// panes, including any working agent inside them. There is no guard here
// against closing the last remaining space — whether herdr permits that is
// deliberately UNMEASURED (design doc §17 probe 3), so the herdr-refusal
// test below is the path that measurement depends on: paddock must relay
// herdr's own refusal rather than predict it.

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "working", workspaceId: "w1",
    workspaceLabel: "example-space", cwd: "/srv/project", harness: "claude",
    stateSince: NOW, stateSinceExact: true, updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
  };
}

const TREE: SpaceTree = {
  readAt: NOW,
  spaces: [{
    spaceId: "w1", label: "example-space", tabCount: 1, paneCount: 1,
    tabs: [{
      tabId: "w1:t1", label: "docs-cleanup",
      panes: [
        { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "api-refactor", cwd: "/srv/project", state: "working" },
      ],
    }],
  }],
};

function harness(
  readTree?: () => Promise<SpaceTree>,
  overrides: {
    closeTab?: (tabId: string) => Promise<void>;
    closeSpace?: (spaceId: string) => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app = createApp({
    store,
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    readTree,
    actions: {
      async readOutput() { return { lines: [], source: "visible" as const }; },
      async readPane() { return { lines: [], source: "recent_unwrapped" as const }; },
      async readDetection() { return ""; },
      async sendOptionKey() {},
      async sendNavKey() {},
      async sendReply() {},
      async sendPaneText() {},
      async sendPaneKey() {},
      async waitUntilUnblocked() {},
      async renameAgent() {},
      async renameTab() {},
      async renameSpace() {},
      async closeTab(tabId: string) {
        calls.push(`closeTab:${tabId}`);
        if (overrides.closeTab) await overrides.closeTab(tabId);
      },
      async closeSpace(spaceId: string) {
        calls.push(`closeSpace:${spaceId}`);
        if (overrides.closeSpace) await overrides.closeSpace(spaceId);
      },
    },
    health: () => ({
      ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW,
      lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null,
      schemaWarning: null,
    }),
  });
  return { app, calls, store };
}

const post = (app: any, path: string) =>
  app.request(path, { method: "POST" });

// ── /api/tabs/:id/close ──────────────────────────────────────────────────────
// Validated against `deps.readTree`, not the store — a tab is not an agent
// and is not in `AgentStore` (§3).

test("a valid tab close reaches closeTab with the right id, and reports what closed", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/tabs/w1:t1/close");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true, tabId: "w1:t1", label: "docs-cleanup", paneCount: 1,
  });
  expect(calls).toEqual(["closeTab:w1:t1"]);
});

test("closing an unknown tab 404s before anything is sent", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/tabs/nope/close");
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown tab");
  expect(calls).toEqual([]);
});

test("without a herdr reader, closing a tab 404s honestly", async () => {
  const { app, calls } = harness(undefined);
  const res = await post(app, "/api/tabs/w1:t1/close");
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
  expect(calls).toEqual([]);
});

test("a herdr refusal to close a tab surfaces as 502 with herdr's own message in detail", async () => {
  const { app, calls } = harness(async () => TREE, {
    closeTab: async () => { throw new Error("tab_not_found"); },
  });
  const res = await post(app, "/api/tabs/w1:t1/close");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("tab_not_found");
  expect(calls).toEqual(["closeTab:w1:t1"]);
});

test("a readTree throw for /api/tabs/:id/close becomes ok:false/502, never a bare 500", async () => {
  const { app, calls } = harness(async () => { throw new Error("herdr socket refused"); });
  const res = await post(app, "/api/tabs/w1:t1/close");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("herdr socket refused");
  expect(calls).toEqual([]);
});

// ── /api/spaces/:id/close ─────────────────────────────────────────────────────
// Same authority and same shape as /api/tabs/:id/close, for the same reasons.
// No guard here against closing the last space — see the file-level comment.

test("a valid space close reaches closeSpace with the right id, and reports what closed", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/w1/close");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true, spaceId: "w1", label: "example-space", tabCount: 1, paneCount: 1,
  });
  expect(calls).toEqual(["closeSpace:w1"]);
});

test("closing an unknown space 404s before anything is sent", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/nope/close");
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown space");
  expect(calls).toEqual([]);
});

test("without a herdr reader, closing a space 404s honestly", async () => {
  const { app, calls } = harness(undefined);
  const res = await post(app, "/api/spaces/w1/close");
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
  expect(calls).toEqual([]);
});

test("herdr's refusal to close the last space surfaces as 502 with its own message in detail", async () => {
  // This is the path §17 probe 3 depends on: paddock never assumes herdr's
  // policy on a single remaining space, so a refusal from herdr must arrive
  // at the operator as herdr's own reason, not a paddock-authored guess and
  // not a silent no-op.
  const { app, calls } = harness(async () => TREE, {
    closeSpace: async () => { throw new Error("cannot close the last workspace"); },
  });
  const res = await post(app, "/api/spaces/w1/close");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("cannot close the last workspace");
  expect(calls).toEqual(["closeSpace:w1"]);
});

test("a readTree throw for /api/spaces/:id/close becomes ok:false/502, never a bare 500", async () => {
  const { app, calls } = harness(async () => { throw new Error("herdr socket refused"); });
  const res = await post(app, "/api/spaces/w1/close");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("herdr socket refused");
  expect(calls).toEqual([]);
});
