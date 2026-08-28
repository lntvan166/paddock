import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_START_TIMEOUT_MS, agentStartTimeoutMs, createActions,
} from "@server/herdr/actions";
import { HERDR_TIMEOUT_MS } from "@server/herdr/socket";
import { createApp } from "@server/routes";
import { expandHome } from "@server/herdr/tree";

/**
 * A cwd as `CreateOpts` requires it — minted through the ONE function allowed
 * to, which is the point of the `HostPath` brand: nothing can hand herdr a raw
 * client string without going through the tilde expansion. An absolute path
 * never comes back null, so the assertion is safe here.
 */
const hostPath = (p: string) => expandHome(p, "/base/operator")!;
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
    await createActions(path).createSpace({ label: "api-refactor", cwd: hostPath("/srv/project") });
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

test("startAgent forwards name verbatim — no default, no fallback to kind", async () => {
  // `agent.start`'s `name` is a REQUIRED field (docs/design/2026-08-19-…
  // §10: `{name, kind, pane_id, args?, timeout_ms?}`, no `?` on name), and
  // whether herdr accepts `null` for it was never measured — this task is
  // not authorised to spawn a live agent to check. So this function makes
  // no decision about `name` at all: the caller (the route, which refuses
  // an absent/blank one with 400) always has a valid non-empty string in
  // hand by the time this runs. An earlier version defaulted an absent
  // name to `kind` — reverted, see the interface doc in actions.ts for why.
  const { path, seen, stop } = await fakeHerdr(() => AGENT_STARTED);
  try {
    await createActions(path).startAgent("w1:p9", "claude", "schema-migration");
    expect(seen[0].params.name).toBe("schema-migration");
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
    startAgent?: (paneId: string, kind: string, name: string, args?: string[]) => Promise<void>;
    harnessKinds?: () => Promise<string[]>;
    /** The operator's home directory, for the tilde expansion the create
     *  routes apply to `cwd`. Absent in every other test here, which is the
     *  documented no-op case. */
    home?: string;
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
    home: overrides.home,
    actions: {
      async readOutput() { return { lines: [], source: "visible" as const }; },
      async readPane() { return { lines: [], source: "recent_unwrapped" as const }; },
      async readPromptScreen() { return ""; },
      async sendOptionKey() {},
      async sendChars() {},
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
  const res = await post(app, "/api/panes/w1:p2/agent", { kind: "not-installed", name: "docs-cleanup" });
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
  const res = await post(app, "/api/panes/nope/agent", { kind: "claude", name: "docs-cleanup" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown pane");
  expect(calls).toEqual([]);
});

test("a missing, empty, or whitespace-only name is refused 400 before the tree is even read", async () => {
  const { app, calls, readTreeCallCount } = harness(async () => TREE);
  for (const body of [{ kind: "claude" }, { kind: "claude", name: "" }, { kind: "claude", name: "   " }, { kind: "claude", name: 5 }]) {
    const res = await post(app, "/api/panes/w1:p2/agent", body);
    expect(res.status).toBe(400);
  }
  // Never reaches the manifest check or agent.start — a client input error,
  // same shape a rename route's blank label gets.
  expect(calls).toEqual([]);
  expect(readTreeCallCount()).toBe(0);
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
  const res = await post(app, "/api/panes/w1:p2/agent", { kind: "claude", name: "docs-cleanup" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("shell exists, but the agent did not start");
  expect(body.detail).toContain("harness binary not found");
  expect(calls).toEqual(["harnessKinds", `startAgent:w1:p2:claude:docs-cleanup:${JSON.stringify(null)}`]);
});

test("a readTree throw for starting an agent becomes ok:false/502, never a bare 500", async () => {
  const { app, calls } = harness(async () => { throw new Error("herdr socket refused"); });
  const res = await post(app, "/api/panes/w1:p2/agent", { kind: "claude", name: "docs-cleanup" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("herdr socket refused");
  expect(calls).toEqual([]);
});

test("a pane that already has an agent is refused with 409, like its three siblings", async () => {
  // `/api/panes/:id/output`, `/text` and `/key` all answer 409 on a pane whose
  // `harness` is not null — "this pane has an agent; use /api/agents/:id/…".
  // This route validated the pane's EXISTENCE and then started an agent
  // regardless, so a spawn into an occupied pane became `agent.start`'s
  // problem, and what herdr does with that is unmeasured. A fourth pane route
  // answering a fourth way to the same question is the inconsistency; 409 is
  // the answer the other three already give.
  const { app, calls, readTreeCallCount } = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p1/agent", { kind: "claude", name: "docs-cleanup" });
  expect(res.status).toBe(409);
  expect((await res.json() as any).detail).toContain("this pane has an agent");
  // Distinguishable from a 502 by construction: herdr was never asked, not
  // even for the installed kinds.
  expect(calls).toEqual([]);
  expect(readTreeCallCount()).toBe(1);
});

test("args must be an array of strings, or the call is refused before anything is sent", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p2/agent", { kind: "claude", name: "docs-cleanup", args: ["ok", 5] });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("args is bounded by paddock's own policy, in count and in total length", async () => {
  // `args` was the ONE client value on this branch reaching a herdr parameter
  // with no paddock bound on it. `MAX_READ_LINES`, `MAX_TEXT_LEN`,
  // `MAX_LABEL_LEN` and `MAX_WAIT_TIMEOUT_MS` all exist for exactly this
  // reason, and this one is forwarded into a SPAWNED PROCESS'S argv — so
  // `{"args": ["x".repeat(1e8)]}` was buffered here and pushed at herdr.
  //
  // Refused, never truncated: the same rule as a rename label, and for a
  // stronger reason — a silently shortened argument is a different command.
  const long = harness(async () => TREE);
  const big = await post(long.app, "/api/panes/w1:p2/agent", {
    kind: "claude", name: "docs-cleanup", args: ["x".repeat(20_000)],
  });
  expect(big.status).toBe(400);
  expect((await big.json() as any).detail).toContain("length limit");
  expect(long.calls).toEqual([]);

  // Split across many elements, so a per-element bound alone would let it
  // through — the ceiling is on the TOTAL.
  const split = harness(async () => TREE);
  const many = await post(split.app, "/api/panes/w1:p2/agent", {
    kind: "claude", name: "docs-cleanup", args: Array.from({ length: 8 }, () => "y".repeat(2_000)),
  });
  expect(many.status).toBe(400);
  expect(split.calls).toEqual([]);

  // And a count bound, because 100_000 empty strings is 100_000 argv entries
  // at no length cost at all.
  const count = harness(async () => TREE);
  const lots = await post(count.app, "/api/panes/w1:p2/agent", {
    kind: "claude", name: "docs-cleanup", args: Array.from({ length: 200 }, () => ""),
  });
  expect(lots.status).toBe(400);
  expect((await lots.json() as any).detail).toContain("too many");
  expect(count.calls).toEqual([]);

  // An ordinary flag list still goes through untouched.
  const ok = harness(async () => TREE);
  const fine = await post(ok.app, "/api/panes/w1:p2/agent", {
    kind: "claude", name: "docs-cleanup", args: ["--flag", "value"],
  });
  expect(fine.status).toBe(200);
  expect(ok.calls).toEqual([
    // The `kind` allowlist read, then the start — the refusals above reach
    // neither, which is the other half of what this asserts.
    "harnessKinds",
    `startAgent:w1:p2:claude:docs-cleanup:${JSON.stringify(["--flag", "value"])}`,
  ]);
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

test("a tilde-ised cwd is EXPANDED before it reaches herdr, in both create routes", async () => {
  // Measured on a live herd: `workspace.create {cwd: "~/Documents/…"}` is
  // neither expanded nor refused — the new pane came up in the HOME directory
  // with nothing anywhere saying the folder the operator picked had been
  // ignored. The tilde is paddock's own invention (`tildeise` in `tree.ts`, so
  // a username never crosses the wire) and the create sheet's quick picks are
  // the tree's own tilde-ised cwds coming back, so paddock has to undo what
  // paddock did.
  const home = "/base/operator";
  const space = harness(async () => TREE, { home });
  await post(space.app, "/api/spaces", { cwd: "~/work/project" });
  expect(space.calls).toEqual([`createSpace:${JSON.stringify({ cwd: "/base/operator/work/project" })}`]);

  const tab = harness(async () => TREE, { home });
  await post(tab.app, "/api/spaces/w1/tabs", { cwd: "~" });
  expect(tab.calls).toEqual([`createTab:w1:${JSON.stringify({ cwd: "/base/operator" })}`]);
});

test("an absolute cwd is forwarded untouched, and so is one on a server with no HOME", async () => {
  const withHome = harness(async () => TREE, { home: "/base/operator" });
  await post(withHome.app, "/api/spaces", { cwd: "/srv/project" });
  expect(withHome.calls).toEqual([`createSpace:${JSON.stringify({ cwd: "/srv/project" })}`]);

  // FLIPPED. This asserted that `~/work` on a server with no HOME was
  // forwarded unchanged, "the same thing `tildeise` does in that case". That
  // was wrong for the inbound direction and it is the whole reason this
  // function exists: `tildeise` declining to act leaves a real absolute path
  // alone, whereas forwarding a tilde hands herdr the one value measured to
  // produce a pane in the wrong folder with nothing said. With no home there
  // is nothing to expand against, so it is refused instead — see the refusal
  // test below.
  const noHome = harness(async () => TREE);
  const res2 = await post(noHome.app, "/api/spaces", { cwd: "~/work" });
  expect(res2.status).toBe(400);
  expect(noHome.calls).toEqual([]);
});

test("the cwd length ceiling is measured against what the CLIENT sent, not the expansion", async () => {
  // Otherwise the bound would move with the length of this machine's home
  // path: the same request would be accepted on one box and refused on
  // another.
  const { app, calls } = harness(async () => TREE, { home: "/base/operator" });
  const res = await post(app, "/api/spaces", { cwd: `~/${"a".repeat(10_001)}` });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a tilde that cannot be resolved is REFUSED 400, never forwarded, on both create routes", async () => {
  // The whole point of the expansion is that herdr was measured to neither
  // expand nor refuse a `~` — it silently starts the pane in the home
  // directory. A value that is STILL tilde-prefixed after expansion is
  // therefore the exact input the expansion exists to stop, and forwarding it
  // would leave the defect inside its own fix.
  const home = "/base/operator";

  // Another user's home. Resolving it against $HOME would point at a
  // different account's path — worse than refusing.
  const other = harness(async () => TREE, { home });
  const res = await post(other.app, "/api/spaces", { cwd: "~someone/work" });
  expect(res.status).toBe(400);
  expect((await res.json() as any).detail).toContain("absolute path");
  expect(other.calls).toEqual([]);

  // `~work` as well: on a real shell that is user `work`'s home, not a
  // relative name, so reading it either way is a guess. The rule is the simple
  // one — still tilde-prefixed after expansion means refused.
  const bare = harness(async () => TREE, { home });
  expect((await post(bare.app, "/api/spaces", { cwd: "~work" })).status).toBe(400);
  expect(bare.calls).toEqual([]);

  // Nothing to expand against. The tab route shares `normalizeCreateBody`, so
  // it is asserted on the other shape rather than on a second copy of the
  // first.
  const noHome = harness(async () => TREE);
  const tab = await post(noHome.app, "/api/spaces/w1/tabs", { cwd: "~/work" });
  expect(tab.status).toBe(400);
  expect((await tab.json() as any).detail).toContain("absolute path");
  // Refused BEFORE the space id was even validated: no tree read, no herdr
  // call. That is also what keeps this 400 distinguishable from the 502 the
  // catch produces — the refusal returns from outside the `try` entirely.
  expect(noHome.calls).toEqual([]);
  expect(noHome.readTreeCallCount()).toBe(0);
});

test("an absolute path is forwarded verbatim, refusal or not", async () => {
  // Nothing is done to a path that is already absolute: no normalisation, no
  // existence check. Whether herdr accepts THIS absolute path is herdr's
  // business, and its answer arrives verbatim either way.
  const { app, calls } = harness(async () => TREE, { home: "/base/operator" });
  const res = await post(app, "/api/spaces", { cwd: "/srv/project" });
  expect(res.status).toBe(200);
  expect(calls).toEqual([`createSpace:${JSON.stringify({ cwd: "/srv/project" })}`]);
});

test("a RELATIVE cwd is refused, the same as a tilde paddock cannot resolve", async () => {
  // FLIPPED. This asserted a 200 and a forwarded `./relative`, two lines below
  // the test that asserts a 400 for `~work` — the same class of value, refused
  // in one shape and forwarded in the other, by the function that exists to
  // stop it. Whether herdr resolves a relative cwd against its own process cwd
  // is UNMEASURED; the measured answer for the tilde was "silently, in the
  // wrong folder", which is the outcome this whole path exists to prevent.
  //
  // Refuse an unmeasured value when a measured alternative expresses the same
  // intent; relay when there is none. An absolute path is that alternative, so
  // this refuses — and no UI path produces a relative cwd (the quick picks are
  // the tree's own `~/…` or absolute cwds), so nothing regresses.
  const { app, calls, readTreeCallCount } = harness(async () => TREE, { home: "/base/operator" });
  const res = await post(app, "/api/spaces", { cwd: "./relative" });
  expect(res.status).toBe(400);
  expect((await res.json() as any).detail).toContain("absolute path");
  // Same posture as the tilde refusal: returned from outside the `try`, so it
  // can never be relabelled a 502, and herdr is never asked.
  expect(calls).toEqual([]);
  expect(readTreeCallCount()).toBe(0);
});
