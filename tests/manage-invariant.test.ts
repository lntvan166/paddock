import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent, SpaceTree } from "@shared/types";

// ── The §3 invariant, guarded ────────────────────────────────────────────
//
// Design doc §3: widening `Agent` into `Pane` everywhere would drag panes
// with no agent through `state/store.ts`, the delta path, and
// `notify/notifier.ts` — the code `docs/roadmap.md` already flags as an
// unguarded call site, where a mistake there disables notifications while
// every test stays green. So the nine management routes this plan added
// (rename agent/tab/space, close tab/space, create space/tab, start an
// agent, list harnesses) read the store or the tree to VALIDATE an id, but
// must never WRITE to `AgentStore` and must never enqueue to the `Hub` —
// only the existing reconcile/delta path (`Supervisor` -> `store.replaceAll`
// -> `hub.queue`) and the notifier are allowed to do either.
//
// The previous branch shipped a guard for the sibling half of §3 (a shell
// pane never reaching the store — tests/shell-panes-stay-out.test.ts) and it
// could not fail: a reviewer deleted the line it existed to protect and the
// suite stayed green. This test is written to be immune to that failure
// mode by construction — see the note below the class definitions.
//
// Mechanism: rather than grep the route bodies for the literal method names
// (the way tests/tokens.test.ts greps styles.css for a token), this test
// DRIVES every management route through `createApp` against real
// `AgentStore`/`Hub` instances wrapped to RECORD every call to their
// mutating methods — `AgentStore.replaceAll`/`remove`/`applyEvent`/
// `acknowledge`, and `Hub.queue`. A source-grep would pass on a route that
// calls a locally-bound alias, a helper that forwards to `store.remove`, or
// a mutation added ten lines below a comment claiming there is none; the
// recording wrapper cannot be fooled that way because it is the actual
// object every route call runs against — the same reason
// `tests/notify-wiring.test.ts` and `tests/hub.test.ts` assert against real
// `Hub` instances rather than parsing `index.ts`.

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

/**
 * Records every call to a mutating `AgentStore` method, then delegates to
 * the real implementation — so a route that reaches one of these still
 * gets a working store (a false negative would hide the invariant
 * breaking), it just also leaves a trace this test can assert against.
 * `has` and `snapshot` are deliberately NOT overridden: reading the store
 * to validate an id is the invariant's explicitly allowed half (§3; see
 * `/api/agents/:id/name`'s own comment in routes.ts).
 */
class RecordingStore extends AgentStore {
  readonly writes: string[] = [];

  remove(agentId: string) {
    this.writes.push(`remove:${agentId}`);
    return super.remove(agentId);
  }

  replaceAll(incoming: Agent[], now: number) {
    this.writes.push(`replaceAll:${incoming.length}`);
    return super.replaceAll(incoming, now);
  }

  applyEvent(agentId: string, mutate: (prev: Agent) => Agent) {
    this.writes.push(`applyEvent:${agentId}`);
    return super.applyEvent(agentId, mutate);
  }

  acknowledge(agentId: string, now: number) {
    this.writes.push(`acknowledge:${agentId}`);
    return super.acknowledge(agentId, now);
  }
}

/**
 * Records every call to `Hub.queue` — the literal "enqueue to the hub"
 * `queue()` is a fan-out to every connected browser, delivering the
 * same delta the notifier reads (`notify/notifier.ts` -> `hub.queue(d)` at
 * the composition root). A management route reaching it would mean a
 * rename/close/create could push agent data at every open browser and the
 * notifier's own trigger path, outside the one reconcile loop that is
 * supposed to be the only thing that does.
 */
class RecordingHub extends Hub {
  readonly queued: unknown[] = [];

  queue(delta: { upserted: Agent[]; removedIds: string[] }) {
    this.queued.push(delta);
    return super.queue(delta);
  }
}

function harness() {
  const store = new RecordingStore("dev-box");
  store.replaceAll([agent()], NOW); // setup, not a route call — cleared below
  const hub = new RecordingHub({ now: () => NOW });

  const actionCalls: string[] = [];
  const app = createApp({
    store,
    hub,
    now: () => NOW,
    readTree: async () => TREE,
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
      async renameAgent(target, name) { actionCalls.push(`renameAgent:${target}:${name}`); },
      async renameTab(tabId, label) { actionCalls.push(`renameTab:${tabId}:${label}`); },
      async renameSpace(spaceId, label) { actionCalls.push(`renameSpace:${spaceId}:${label}`); },
      async closeTab(tabId) { actionCalls.push(`closeTab:${tabId}`); },
      async closeSpace(spaceId) { actionCalls.push(`closeSpace:${spaceId}`); },
      async createSpace(opts) {
        actionCalls.push(`createSpace:${JSON.stringify(opts)}`);
        return { spaceId: "w9", tabId: "w9:t1", paneId: "w9:p1" };
      },
      async createTab(spaceId, opts) {
        actionCalls.push(`createTab:${spaceId}:${JSON.stringify(opts)}`);
        return { tabId: "w1:t9", paneId: "w1:p9" };
      },
      async startAgent(paneId, kind, name, args) {
        actionCalls.push(`startAgent:${paneId}:${kind}:${name}:${JSON.stringify(args ?? null)}`);
      },
      async harnessKinds() { return ["claude", "codex"]; },
    },
    health: () => ({
      ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW,
      lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null,
      schemaWarning: null,
    }),
  });

  // The setup `replaceAll` above is test scaffolding, not a route under
  // test — clear it so the assertions below start from a clean slate and
  // report only what the ROUTES themselves did.
  store.writes.length = 0;

  return { app, store, hub, actionCalls };
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const get = (app: ReturnType<typeof createApp>, path: string) => app.request(path, { method: "GET" });

// One request per management route this plan added, each against a fixture
// where it succeeds — a route that 404s before reaching its herdr call
// would trivially "pass" a guard that only ran on the failure path, so
// every test below first proves `ok:true` before the invariant is checked
// underneath it.

test("renaming an agent writes nothing to the store and enqueues nothing to the hub", async () => {
  const { app, store, hub, actionCalls } = harness();
  const res = await post(app, "/api/agents/w1:p1/name", { name: "renamed-agent" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(actionCalls).toEqual(["renameAgent:w1:p1:renamed-agent"]);
  expect(store.writes).toEqual([]);
  expect(hub.queued).toEqual([]);
});

test("renaming a tab writes nothing to the store and enqueues nothing to the hub", async () => {
  const { app, store, hub, actionCalls } = harness();
  const res = await post(app, "/api/tabs/w1:t1/name", { label: "renamed-tab" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(actionCalls).toEqual(["renameTab:w1:t1:renamed-tab"]);
  expect(store.writes).toEqual([]);
  expect(hub.queued).toEqual([]);
});

test("renaming a space writes nothing to the store and enqueues nothing to the hub", async () => {
  const { app, store, hub, actionCalls } = harness();
  const res = await post(app, "/api/spaces/w1/name", { label: "renamed-space" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(actionCalls).toEqual(["renameSpace:w1:renamed-space"]);
  expect(store.writes).toEqual([]);
  expect(hub.queued).toEqual([]);
});

test("closing a tab writes nothing to the store and enqueues nothing to the hub", async () => {
  const { app, store, hub, actionCalls } = harness();
  const res = await post(app, "/api/tabs/w1:t1/close");
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(actionCalls).toEqual(["closeTab:w1:t1"]);
  expect(store.writes).toEqual([]);
  expect(hub.queued).toEqual([]);
});

test("closing a space writes nothing to the store and enqueues nothing to the hub", async () => {
  const { app, store, hub, actionCalls } = harness();
  const res = await post(app, "/api/spaces/w1/close");
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(actionCalls).toEqual(["closeSpace:w1"]);
  expect(store.writes).toEqual([]);
  expect(hub.queued).toEqual([]);
});

test("creating a space writes nothing to the store and enqueues nothing to the hub", async () => {
  const { app, store, hub, actionCalls } = harness();
  const res = await post(app, "/api/spaces", { label: "schema-migration" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(actionCalls).toEqual([`createSpace:${JSON.stringify({ label: "schema-migration" })}`]);
  expect(store.writes).toEqual([]);
  expect(hub.queued).toEqual([]);
});

test("creating a tab writes nothing to the store and enqueues nothing to the hub", async () => {
  const { app, store, hub, actionCalls } = harness();
  const res = await post(app, "/api/spaces/w1/tabs", { label: "schema-migration" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(actionCalls).toEqual([`createTab:w1:${JSON.stringify({ label: "schema-migration" })}`]);
  expect(store.writes).toEqual([]);
  expect(hub.queued).toEqual([]);
});

test("starting an agent writes nothing to the store and enqueues nothing to the hub", async () => {
  const { app, store, hub, actionCalls } = harness();
  const res = await post(app, "/api/panes/w1:p1/agent", { kind: "claude", name: "docs-cleanup" });
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(actionCalls).toEqual(["startAgent:w1:p1:claude:docs-cleanup:null"]);
  expect(store.writes).toEqual([]);
  expect(hub.queued).toEqual([]);
});

test("listing installed harnesses writes nothing to the store and enqueues nothing to the hub", async () => {
  const { app, store, hub, actionCalls } = harness();
  const res = await get(app, "/api/harnesses");
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(actionCalls).toEqual([]);
  expect(store.writes).toEqual([]);
  expect(hub.queued).toEqual([]);
});

test("all nine management routes together still write nothing and enqueue nothing", async () => {
  // The per-route tests above each start from a fresh store/hub. This one
  // drives every route against a SHARED store/hub, back to back, so the
  // guard also covers a violation that only shows up once state has
  // accumulated across calls (e.g. a route that reads its own prior write).
  const { app, store, hub } = harness();
  await post(app, "/api/agents/w1:p1/name", { name: "renamed-agent" });
  await post(app, "/api/tabs/w1:t1/name", { label: "renamed-tab" });
  await post(app, "/api/spaces/w1/name", { label: "renamed-space" });
  await post(app, "/api/tabs/w1:t1/close");
  await post(app, "/api/spaces/w1/close");
  await post(app, "/api/spaces", { label: "schema-migration" });
  await post(app, "/api/spaces/w1/tabs", { label: "schema-migration" });
  await post(app, "/api/panes/w1:p1/agent", { kind: "claude", name: "docs-cleanup" });
  await get(app, "/api/harnesses");
  expect(store.writes).toEqual([]);
  expect(hub.queued).toEqual([]);
});
