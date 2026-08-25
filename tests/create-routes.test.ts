import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_START_TIMEOUT_MS, agentStartTimeoutMs, createActions,
} from "@server/herdr/actions";
import { HERDR_TIMEOUT_MS } from "@server/herdr/socket";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent, SpaceTree } from "@shared/types";

// ── POST /api/spaces, POST /api/spaces/:id/tabs, POST /api/panes/:id/agent,
//    GET /api/harnesses
//
// Two layers, because the properties this task exists to guarantee live at
// two different boundaries:
//
//  - The ACTIONS layer (`createActions`, exercised here against a real fake
//    herdr socket, same convention as tests/actions.test.ts) is where
//    `focus: false`, the envelope-not-snapshot id parsing, and the
//    `agent.start` timeout override actually happen — none of that is
//    visible to a route test that injects a fake `HerdrActions`.
//  - The ROUTES layer (exercised here with injected fakes, same convention
//    as tests/close-routes.test.ts) is where validation, the kind
//    allowlist, 404/400/502, and the partial-failure wording live.
//
// §9.1's correction is the throughline: `tab.create`/`workspace.create`
// return an ENVELOPE carrying `root_pane` alongside the new tab/workspace,
// so the new pane's id is read directly off it. There is no second
// `session.snapshot` read to find it — a route-level test below asserts
// `deps.readTree` is called at most once per create, so that removed step
// cannot come back; an actions-level test below asserts the same thing one
// level down, by counting the raw herdr calls a create makes.

const NOW = 1_700_000_000_000;

// ═══════════════════════════════════════════════════════════════════════
// Actions layer — a real fake herdr socket, same convention as
// tests/actions.test.ts.
// ═══════════════════════════════════════════════════════════════════════

async function fakeHerdr(handler: (req: any) => object) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-create-"));
  const path = join(dir, "h.sock");
  const seen: any[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(s, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          seen.push(req);
          s.write(JSON.stringify({ id: req.id, result: handler(req) }) + "\n");
          s.end();
        }
      },
    },
  });
  return { path, seen, stop: () => server.stop(true) };
}

/** `tab.create` -> envelope, root_pane alongside tab. Invented ids/labels
 *  only — never a real workspace/tab/pane id or label. */
function tabCreated() {
  return {
    type: "tab_created",
    tab: { tab_id: "w1:t9", workspace_id: "w1", label: "schema-migration", number: 9, agent_status: "idle", pane_count: 1, focused: false },
    root_pane: { pane_id: "w1:p9", workspace_id: "w1", tab_id: "w1:t9", agent: null, agent_status: "idle", cwd: "/srv/project", focused: false, revision: 1 },
  };
}

/** `workspace.create` -> envelope, one level up. */
function workspaceCreated() {
  return {
    type: "workspace_created",
    workspace: { workspace_id: "w9", label: "api-refactor", number: 9, agent_status: "idle", pane_count: 1, tab_count: 1, focused: false },
    tab: { tab_id: "w9:t1", workspace_id: "w9", label: null, number: 1, agent_status: "idle", pane_count: 1, focused: false },
    root_pane: { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1", agent: null, agent_status: "idle", cwd: "/srv/project", focused: false, revision: 1 },
  };
}

const AGENT_STARTED = {
  type: "agent_started",
  agent: {
    agent: "claude", agent_status: "idle", cwd: "/srv/project", focused: false,
    name: "docs-cleanup", pane_id: "w1:p9", revision: 1, tab_id: "w1:t9",
    terminal_id: "term_1", workspace_id: "w1",
  },
};

const MANIFESTS = {
  type: "agent_manifest_status",
  manifests: [{ agent: "claude" }, { agent: "codex" }],
};

test("createSpace reads workspace/tab/pane ids straight off workspace.create's own envelope", async () => {
  const { path, seen, stop } = await fakeHerdr(() => workspaceCreated());
  try {
    const out = await createActions(path).createSpace({ label: "api-refactor" });
    expect(seen[0].method).toBe("workspace.create");
    expect(out).toEqual({ spaceId: "w9", tabId: "w9:t1", paneId: "w9:p1" });
  } finally { stop(); }
});

test("createSpace makes exactly ONE herdr call — no snapshot re-read to find the new pane", async () => {
  const { path, seen, stop } = await fakeHerdr(() => workspaceCreated());
  try {
    await createActions(path).createSpace({});
    expect(seen.length).toBe(1);
    expect(seen[0].method).not.toBe("session.snapshot");
  } finally { stop(); }
});

test("createSpace always sends focus:false", async () => {
  const { path, seen, stop } = await fakeHerdr(() => workspaceCreated());
  try {
    await createActions(path).createSpace({ label: "api-refactor", cwd: "/srv/project" });
    expect(seen[0].params.focus).toBe(false);
    expect(seen[0].params.label).toBe("api-refactor");
    expect(seen[0].params.cwd).toBe("/srv/project");
  } finally { stop(); }
});

test("createTab reads tab/pane ids straight off tab.create's own envelope, scoped to the space", async () => {
  const { path, seen, stop } = await fakeHerdr(() => tabCreated());
  try {
    const out = await createActions(path).createTab("w1", { label: "schema-migration" });
    expect(seen[0].method).toBe("tab.create");
    expect(seen[0].params.workspace_id).toBe("w1");
    expect(out).toEqual({ tabId: "w1:t9", paneId: "w1:p9" });
  } finally { stop(); }
});

test("createTab makes exactly ONE herdr call and always sends focus:false", async () => {
  const { path, seen, stop } = await fakeHerdr(() => tabCreated());
  try {
    await createActions(path).createTab("w1", {});
    expect(seen.length).toBe(1);
    expect(seen[0].params.focus).toBe(false);
  } finally { stop(); }
});

test("harnessKinds reads the agent names off server.agent_manifests", async () => {
  const { path, seen, stop } = await fakeHerdr(() => MANIFESTS);
  try {
    const kinds = await createActions(path).harnessKinds();
    expect(seen[0].method).toBe("server.agent_manifests");
    expect(kinds).toEqual(["claude", "codex"]);
  } finally { stop(); }
});

test("startAgent sends pane_id/kind and a timeout_ms body field inside herdr's own bound", async () => {
  const { path, seen, stop } = await fakeHerdr(() => AGENT_STARTED);
  try {
    await createActions(path).startAgent("w1:p9", "claude", "docs-cleanup", ["--flag"]);
    expect(seen[0].method).toBe("agent.start");
    expect(seen[0].params.pane_id).toBe("w1:p9");
    expect(seen[0].params.kind).toBe("claude");
    expect(seen[0].params.name).toBe("docs-cleanup");
    expect(seen[0].params.args).toEqual(["--flag"]);
    // herdr enforces: strictly greater than 3000ms, no more than 300000ms.
    expect(seen[0].params.timeout_ms).toBeGreaterThan(3_000);
    expect(seen[0].params.timeout_ms).toBeLessThanOrEqual(300_000);
    expect(seen[0].params.timeout_ms).toBe(AGENT_START_TIMEOUT_MS);
  } finally { stop(); }
});

test("startAgent defaults an absent name to the kind, never to null", async () => {
  // `agent.start`'s `name` is a REQUIRED field (docs/design/2026-08-19-…
  // §10: `{name, kind, pane_id, args?, timeout_ms?}`, no `?` on name), and
  // whether herdr accepts `null` for it was never measured — this task is
  // not authorised to spawn a live agent to check. `kind` is always a valid
  // non-empty string, so it is the default that needs no such measurement.
  const { path, seen, stop } = await fakeHerdr(() => AGENT_STARTED);
  try {
    await createActions(path).startAgent("w1:p9", "claude", null);
    expect(seen[0].params.name).toBe("claude");
  } finally { stop(); }
});

// Same pattern as tests/actions.test.ts's waitUntilUnblocked proof: every
// setTimeout is scaled down so the real millisecond RELATIONSHIP between
// HERDR_TIMEOUT_MS and the override holds while the test costs only a few
// hundred real milliseconds. Without a per-call override, this call would
// time out at HERDR_TIMEOUT_MS (10s) while herdr is still legitimately
// inside the ~30s readiness wait it was told it could use.
test("agent.start's transport ceiling exceeds HERDR_TIMEOUT_MS, so a slow-but-legitimate start still resolves", async () => {
  const SCALE = 50;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
    realSetTimeout(fn as any, Math.max(1, (ms ?? 0) / SCALE), ...args)) as unknown as typeof setTimeout;

  try {
    const dir = await mkdtemp(join(tmpdir(), "paddock-create-"));
    const path = join(dir, "h.sock");
    let stopServer = () => {};
    const server = Bun.listen({
      unix: path,
      socket: {
        data(s, chunk) {
          for (const line of chunk.toString().split("\n")) {
            if (!line.trim()) continue;
            const req = JSON.parse(line);
            // Answers 1s past HERDR_TIMEOUT_MS — inside AGENT_START_TIMEOUT_MS
            // (30s) but past what a bare, unoverridden call would allow.
            setTimeout(() => {
              s.write(JSON.stringify({ id: req.id, result: AGENT_STARTED }) + "\n");
              s.end();
            }, HERDR_TIMEOUT_MS + 1_000);
          }
        },
      },
    });
    stopServer = () => server.stop(true);
    try {
      expect(agentStartTimeoutMs()).toBeGreaterThan(HERDR_TIMEOUT_MS);
      await expect(
        createActions(path).startAgent("w1:p9", "claude", "docs-cleanup"),
      ).resolves.toBeUndefined();
    } finally { stopServer(); }
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Routes layer — injected fakes, same convention as tests/close-routes.test.ts.
// ═══════════════════════════════════════════════════════════════════════

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
        { paneId: "w1:p2", harness: null, name: null, title: null, cwd: "/srv/project", state: null },
      ],
    }],
  }],
};

function harness(
  readTree: (() => Promise<SpaceTree>) | undefined,
  overrides: {
    createSpace?: (opts: { label?: string; cwd?: string }) => Promise<{ spaceId: string; tabId: string; paneId: string }>;
    createTab?: (spaceId: string, opts: { label?: string; cwd?: string }) => Promise<{ tabId: string; paneId: string }>;
    startAgent?: (paneId: string, kind: string, name: string | null, args?: string[]) => Promise<void>;
    harnessKinds?: () => Promise<string[]>;
  } = {},
) {
  const calls: string[] = [];
  let readTreeCalls = 0;
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const countedReadTree = readTree
    ? async () => { readTreeCalls++; return readTree(); }
    : undefined;
  const app = createApp({
    store,
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    readTree: countedReadTree,
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
      async closeTab() {},
      async closeSpace() {},
      async createSpace(opts) {
        calls.push(`createSpace:${JSON.stringify(opts)}`);
        if (overrides.createSpace) return overrides.createSpace(opts);
        return { spaceId: "w9", tabId: "w9:t1", paneId: "w9:p1" };
      },
      async createTab(spaceId, opts) {
        calls.push(`createTab:${spaceId}:${JSON.stringify(opts)}`);
        if (overrides.createTab) return overrides.createTab(spaceId, opts);
        return { tabId: "w1:t9", paneId: "w1:p9" };
      },
      async startAgent(paneId, kind, name, args) {
        calls.push(`startAgent:${paneId}:${kind}:${name}:${JSON.stringify(args ?? null)}`);
        if (overrides.startAgent) await overrides.startAgent(paneId, kind, name, args);
      },
      async harnessKinds() {
        calls.push("harnessKinds");
        return overrides.harnessKinds ? overrides.harnessKinds() : ["claude", "codex"];
      },
    },
    health: () => ({
      ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW,
      lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null,
      schemaWarning: null,
    }),
  });
  return { app, calls, readTreeCallCount: () => readTreeCalls };
}

const post = (app: any, path: string, body: unknown = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const get = (app: any, path: string) => app.request(path, { method: "GET" });

// ── POST /api/spaces ─────────────────────────────────────────────────────

test("creating a space returns the ids the fake reported, and makes NO tree read at all", async () => {
  const { app, calls, readTreeCallCount } = harness(async () => TREE);
  const res = await post(app, "/api/spaces", { label: "api-refactor", cwd: "/srv/project" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, spaceId: "w9", tabId: "w9:t1", paneId: "w9:p1" });
  expect(calls).toEqual([`createSpace:${JSON.stringify({ label: "api-refactor", cwd: "/srv/project" })}`]);
  // Nothing existing to validate for a brand-new space — no id to check
  // against the tree, so the snapshot is read zero times, not once.
  expect(readTreeCallCount()).toBe(0);
});

test("creating a space with a blank label treats it as ABSENT, not an error", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces", { label: "   " });
  expect(res.status).toBe(200);
  expect(calls).toEqual([`createSpace:${JSON.stringify({})}`]);
});

test("creating a space with an over-length label is refused 400 and never forwarded", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces", { label: "x".repeat(65) });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("without a herdr reader, creating a space 404s honestly", async () => {
  const { app, calls } = harness(undefined);
  const res = await post(app, "/api/spaces", {});
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
  expect(calls).toEqual([]);
});

test("a herdr failure creating a space becomes ok:false/502 with herdr's own message", async () => {
  const { app, calls } = harness(async () => TREE, {
    createSpace: async () => { throw new Error("workspace_create_failed"); },
  });
  const res = await post(app, "/api/spaces", {});
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("workspace_create_failed");
  expect(calls).toEqual([`createSpace:${JSON.stringify({})}`]);
});

// ── POST /api/spaces/:id/tabs ────────────────────────────────────────────

test("creating a tab returns the ids the fake reported, reading the tree EXACTLY ONCE", async () => {
  const { app, calls, readTreeCallCount } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/w1/tabs", { label: "schema-migration" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, tabId: "w1:t9", paneId: "w1:p9" });
  expect(calls).toEqual([`createTab:w1:${JSON.stringify({ label: "schema-migration" })}`]);
  // The ONE read validates the space id; there is no second read afterward
  // to find the new tab/pane — §9.1's correction is what removed that step.
  expect(readTreeCallCount()).toBe(1);
});

test("creating a tab with a blank cwd treats it as ABSENT, not an error", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/w1/tabs", { cwd: "" });
  expect(res.status).toBe(200);
  expect(calls).toEqual([`createTab:w1:${JSON.stringify({})}`]);
});

test("creating a tab in an unknown space 404s before anything is sent", async () => {
  const { app, calls, readTreeCallCount } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/nope/tabs", {});
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown space");
  expect(calls).toEqual([]);
  expect(readTreeCallCount()).toBe(1);
});

test("without a herdr reader, creating a tab 404s honestly", async () => {
  const { app, calls } = harness(undefined);
  const res = await post(app, "/api/spaces/w1/tabs", {});
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
  expect(calls).toEqual([]);
});

test("an over-length cwd on a tab create is refused 400 and never forwarded", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/spaces/w1/tabs", { cwd: "x".repeat(10_001) });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a herdr failure creating a tab becomes ok:false/502 with herdr's own message", async () => {
  const { app, calls } = harness(async () => TREE, {
    createTab: async () => { throw new Error("tab_create_failed"); },
  });
  const res = await post(app, "/api/spaces/w1/tabs", {});
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("tab_create_failed");
  expect(calls).toEqual([`createTab:w1:${JSON.stringify({})}`]);
});

test("a readTree throw for a tab create becomes ok:false/502, never a bare 500", async () => {
  const { app, calls } = harness(async () => { throw new Error("herdr socket refused"); });
  const res = await post(app, "/api/spaces/w1/tabs", {});
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("herdr socket refused");
  expect(calls).toEqual([]);
});

// ── POST /api/panes/:id/agent ────────────────────────────────────────────

test("starting an agent in an existing pane succeeds and echoes the pane id", async () => {
  const { app, calls, readTreeCallCount } = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p2/agent", { kind: "claude", name: "docs-cleanup" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, paneId: "w1:p2" });
  expect(calls).toEqual([
    "harnessKinds",
    `startAgent:w1:p2:claude:docs-cleanup:${JSON.stringify(null)}`,
  ]);
  expect(readTreeCallCount()).toBe(1);
});

test("a kind not in server.agent_manifests is refused 400 and agent.start is never called", async () => {
  const { app, calls } = harness(async () => TREE, {
    harnessKinds: async () => ["claude", "codex"],
  });
  const res = await post(app, "/api/panes/w1:p2/agent", { kind: "not-installed" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("not-installed");
  // The allowlist call happened (it has to, to know the answer); the START
  // call — the one that actually spends quota — never did.
  expect(calls).toEqual(["harnessKinds"]);
  expect(calls.some((c) => c.startsWith("startAgent"))).toBe(false);
});

test("starting an agent in an unknown pane 404s before the manifest list is even read", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/nope/agent", { kind: "claude" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown pane");
  expect(calls).toEqual([]);
});

test("a missing or blank kind is refused 400 before the tree is even read", async () => {
  const { app, calls, readTreeCallCount } = harness(async () => TREE);
  for (const body of [{}, { kind: "" }, { kind: "   " }, { kind: 5 }]) {
    const res = await post(app, "/api/panes/w1:p2/agent", body);
    expect(res.status).toBe(400);
  }
  expect(calls).toEqual([]);
  expect(readTreeCallCount()).toBe(0);
});

test("without a herdr reader, starting an agent 404s honestly", async () => {
  const { app, calls } = harness(undefined);
  const res = await post(app, "/api/panes/w1:p2/agent", { kind: "claude" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
  expect(calls).toEqual([]);
});

// The partial-failure case: by the time `agent.start` runs, the pane
// ALREADY EXISTS (found on the tree read above, same as every other pane
// action route) and already held a plain shell before this request arrived.
// A failed start is therefore neither success nor nothing, and the detail
// mirrors `/api/panes/:id/text`'s "typed, but not run" — it says which half
// landed rather than leaving the operator to guess whether the pane is
// still there.
test("a failed agent.start reports the shell still exists, distinct from an ordinary 502", async () => {
  const { app, calls } = harness(async () => TREE, {
    startAgent: async () => { throw new Error("harness binary not found"); },
  });
  const res = await post(app, "/api/panes/w1:p2/agent", { kind: "claude" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("shell exists, but the agent did not start");
  expect(body.detail).toContain("harness binary not found");
  expect(calls).toEqual(["harnessKinds", `startAgent:w1:p2:claude:null:${JSON.stringify(null)}`]);
});

test("a readTree throw for starting an agent becomes ok:false/502, never a bare 500", async () => {
  const { app, calls } = harness(async () => { throw new Error("herdr socket refused"); });
  const res = await post(app, "/api/panes/w1:p2/agent", { kind: "claude" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("herdr socket refused");
  expect(calls).toEqual([]);
});

test("args must be an array of strings, or the call is refused before anything is sent", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p2/agent", { kind: "claude", args: ["ok", 5] });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

// ── GET /api/harnesses ────────────────────────────────────────────────────

test("GET /api/harnesses reports the installed kinds", async () => {
  const { app } = harness(async () => TREE, { harnessKinds: async () => ["claude", "codex", "gemini"] });
  const res = await get(app, "/api/harnesses");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, kinds: ["claude", "codex", "gemini"] });
});

test("GET /api/harnesses surfaces a herdr failure as 502 with its own message", async () => {
  const { app } = harness(async () => TREE, {
    harnessKinds: async () => { throw new Error("manifest read failed"); },
  });
  const res = await get(app, "/api/harnesses");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("manifest read failed");
});
