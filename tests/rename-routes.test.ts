import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent, SpaceTree } from "@shared/types";

// ── POST /api/agents/:id/name, POST /api/tabs/:id/name, POST /api/spaces/:id/name
// Built with injected fakes, same convention as tests/pane-input.test.ts —
// no server is started and the operator's real herdr is never touched.

const NOW = 1_700_000_000_000;

/** Same ceiling as `MAX_LABEL_LEN` in `src/server/routes.ts` — not exported,
 *  so mirrored here rather than reached into. */
const MAX_LABEL_LEN = 64;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "blocked", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project", harness: "claude",
    stateSince: NOW, stateSinceExact: true, updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
  };
}

const TREE: SpaceTree = {
  readAt: NOW,
  spaces: [{
    spaceId: "w1", label: "example-space", tabCount: 1, paneCount: 1,
    tabs: [{
      tabId: "w1:t1", label: null,
      panes: [
        { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "api-refactor", cwd: "/srv/project", state: "working" },
      ],
    }],
  }],
};

function harness(
  readTree?: () => Promise<SpaceTree>,
  overrides: {
    renameAgent?: (target: string, name: string | null) => Promise<void>;
    renameTab?: (tabId: string, label: string) => Promise<void>;
    renameSpace?: (spaceId: string, label: string) => Promise<void>;
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
      async renameAgent(target: string, name: string | null) {
        calls.push(`renameAgent:${target}:${name}`);
        if (overrides.renameAgent) await overrides.renameAgent(target, name);
      },
      async renameTab(tabId: string, label: string) {
        calls.push(`renameTab:${tabId}:${label}`);
        if (overrides.renameTab) await overrides.renameTab(tabId, label);
      },
      async renameSpace(spaceId: string, label: string) {
        calls.push(`renameSpace:${spaceId}:${label}`);
        if (overrides.renameSpace) await overrides.renameSpace(spaceId, label);
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

const post = (app: any, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ── /api/agents/:id/name ─────────────────────────────────────────────────────
// Validated against `deps.store` — an agent IS in the store (§3).

test("a valid agent name reaches renameAgent verbatim", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/agents/w1:p1/name", { name: "schema-migration" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toEqual(["renameAgent:w1:p1:schema-migration"]);
});

test("`name: null` on the agent route SUCCEEDS and forwards null — the one real clear", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/agents/w1:p1/name", { name: null });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toEqual(["renameAgent:w1:p1:null"]);
});

test("an over-length agent name is refused 400, not truncated, and never forwarded", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/agents/w1:p1/name", { name: "x".repeat(MAX_LABEL_LEN + 1) });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("an empty-string agent name is refused 400 and never forwarded", async () => {
  // Unlike `null`, an empty string was never measured against herdr's
  // `agent.rename`, so paddock refuses it rather than sending an unmeasured
  // value — the same caution the design applies to tabs and spaces, just for
  // a different reason (there, "" IS measured, and it is worse than what it
  // replaces).
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/agents/w1:p1/name", { name: "" });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a whitespace-only agent name is refused 400 and never forwarded, same as empty", async () => {
  // No UI path submits "" or " " intentionally — `null` is already the
  // clear control's payload — so refusing either forecloses an ambiguous
  // input rather than a real capability.
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/agents/w1:p1/name", { name: "   " });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("renaming an unknown agent 404s before anything is sent", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/agents/nope/name", { name: "docs-cleanup" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown agent");
  expect(calls).toEqual([]);
});

test("a herdr throw from renameAgent becomes ok:false/502, with the message in detail", async () => {
  const { app, calls } = harness(async () => TREE, {
    renameAgent: async () => { throw new Error("agent_not_found"); },
  });
  const res = await post(app, "/api/agents/w1:p1/name", { name: "docs-cleanup" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("agent_not_found");
  expect(calls).toEqual(["renameAgent:w1:p1:docs-cleanup"]);
});

// ── /api/tabs/:id/name ────────────────────────────────────────────────────────
// Validated against `deps.readTree`, not the store — a tab is not an agent
// and is not in `AgentStore` (§3).

test("a valid tab label reaches renameTab verbatim", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/tabs/w1:t1/name", { label: "docs-cleanup" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toEqual(["renameTab:w1:t1:docs-cleanup"]);
});

test("an empty tab label is REFUSED 400 and never forwarded — herdr would store it as \"\", not clear it", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/tabs/w1:t1/name", { label: "" });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a whitespace-only tab label is REFUSED 400 and never forwarded", async () => {
  // Unmeasured, and predictable to be wrong if forwarded: paddock's own
  // `tabLabel` in tree.ts normalises a trimmed-empty label to null (rendered
  // as unnamed), while herdr would be storing the literal whitespace — the
  // same mismatch §17 refuses an empty label to avoid.
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/tabs/w1:t1/name", { label: " " });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("an over-length tab label is refused 400, not truncated, and never forwarded", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/tabs/w1:t1/name", { label: "x".repeat(MAX_LABEL_LEN + 1) });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("renaming an unknown tab 404s before anything is sent", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/tabs/nope/name", { label: "docs-cleanup" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown tab");
  expect(calls).toEqual([]);
});

test("without a herdr reader, renaming a tab 404s honestly", async () => {
  const { app, calls } = harness(undefined);
  const res = await post(app, "/api/tabs/w1:t1/name", { label: "docs-cleanup" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
  expect(calls).toEqual([]);
});

test("a herdr throw from renameTab becomes ok:false/502, with the message in detail", async () => {
  const { app, calls } = harness(async () => TREE, {
    renameTab: async () => { throw new Error("tab_not_found"); },
  });
  const res = await post(app, "/api/tabs/w1:t1/name", { label: "docs-cleanup" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("tab_not_found");
  expect(calls).toEqual(["renameTab:w1:t1:docs-cleanup"]);
});

test("a readTree throw for /api/tabs/:id/name becomes ok:false/502, never a bare 500", async () => {
  const { app, calls } = harness(async () => { throw new Error("herdr socket refused"); });
  const res = await post(app, "/api/tabs/w1:t1/name", { label: "docs-cleanup" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("herdr socket refused");
  expect(calls).toEqual([]);
});

// ── /api/spaces/:id/name ──────────────────────────────────────────────────────
// Same authority and same shape as /api/tabs/:id/name, for the same reasons.

test("a valid space label reaches renameSpace verbatim", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/w1/name", { label: "schema-migration" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toEqual(["renameSpace:w1:schema-migration"]);
});

test("an empty space label is REFUSED 400 and never forwarded — herdr would store it as \"\", not clear it", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/w1/name", { label: "" });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a whitespace-only space label is REFUSED 400 and never forwarded", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/w1/name", { label: " " });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("an over-length space label is refused 400, not truncated, and never forwarded", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/w1/name", { label: "x".repeat(MAX_LABEL_LEN + 1) });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("renaming an unknown space 404s before anything is sent", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/nope/name", { label: "docs-cleanup" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown space");
  expect(calls).toEqual([]);
});

test("without a herdr reader, renaming a space 404s honestly", async () => {
  const { app, calls } = harness(undefined);
  const res = await post(app, "/api/spaces/w1/name", { label: "docs-cleanup" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
  expect(calls).toEqual([]);
});

test("a herdr throw from renameSpace becomes ok:false/502, with the message in detail", async () => {
  const { app, calls } = harness(async () => TREE, {
    renameSpace: async () => { throw new Error("workspace_not_found"); },
  });
  const res = await post(app, "/api/spaces/w1/name", { label: "docs-cleanup" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("workspace_not_found");
  expect(calls).toEqual(["renameSpace:w1:docs-cleanup"]);
});

test("a readTree throw for /api/spaces/:id/name becomes ok:false/502, never a bare 500", async () => {
  const { app, calls } = harness(async () => { throw new Error("herdr socket refused"); });
  const res = await post(app, "/api/spaces/w1/name", { label: "docs-cleanup" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("herdr socket refused");
  expect(calls).toEqual([]);
});
