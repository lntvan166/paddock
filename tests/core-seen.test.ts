import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent } from "@shared/types";
import { Unsupported } from "@server/action-errors";

const NOW = 1_700_000_000_000;

const core = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "core:t1", name: "api-refactor",
  task: "Extract auth middleware", state: "done", workspaceId: "s1",
  workspaceLabel: null, cwd: "/srv/project", harness: "claude",
  stateSince: NOW, stateSinceExact: true, updatedAt: NOW, acknowledgedAt: null,
  hasJournal: false, origin: "core", turn: 7, seen: 3, ...over,
});
const herdr = (over: Partial<Agent> = {}): Agent => core({
  agentId: "w1:p1", origin: "herdr", turn: null, seen: null, ...over,
});

function harness(a: Agent, fail?: Error) {
  const store = new AgentStore("dev-box");
  store.replaceAll([a], NOW, a.origin);
  const marks: [string, number][] = [];
  const actions = {
    async markSeen(t: string, turn: number) {
      if (fail) throw fail;
      marks.push([t, turn]);
    },
  };
  const app = createApp({
    store, hub: new Hub({ now: () => NOW }), actions: actions as never, now: () => NOW,
    health: () => ({}) as never,
  });
  return { app, store, marks };
}
const post = (app: any, path: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

test("dismissing a core agent writes herdr.seen at its turn", async () => {
  const h = harness(core());
  const res = await post(h.app, "/api/agents/core:t1/ack");
  expect(res.status).toBe(200);
  expect(h.marks).toEqual([["core:t1", 7]]);
  // The store is NOT edited here: the labels event brings `seen` back.
  expect(h.store.snapshot()[0]!.seen).toBe(3);
});

test("dismissing a core agent with no turn is refused with a reason, never a silent success", async () => {
  // Nothing to write — and reporting ok for a write that did not happen is a
  // Dismiss that does nothing while saying it worked.
  const h = harness(core({ turn: null, seen: null }));
  const res = await post(h.app, "/api/agents/core:t1/ack");
  expect(res.status).toBe(409);
  expect((await res.json() as { detail: string }).detail).toContain("no turn");
  expect(h.marks).toEqual([]);
});

test("a failed core write is reported, not swallowed", async () => {
  const h = harness(core(), new Unsupported("this is the demo"));
  const res = await post(h.app, "/api/agents/core:t1/ack");
  expect(res.status).toBe(409);
  expect((await res.json() as { detail: string }).detail).toBe("this is the demo");
});

test("opening a core agent writes seen at its turn", async () => {
  const h = harness(core());
  const res = await post(h.app, "/api/agents/core:t1/opened");
  expect(res.status).toBe(204);
  expect(h.marks).toEqual([["core:t1", 7]]);
});

test("opening a core agent with no turn, or a herdr or unknown id, writes nothing", async () => {
  const noTurn = harness(core({ turn: null, seen: null }));
  expect((await post(noTurn.app, "/api/agents/core:t1/opened")).status).toBe(204);
  expect(noTurn.marks).toEqual([]);
  const h = harness(herdr());
  expect((await post(h.app, "/api/agents/w1:p1/opened")).status).toBe(204);
  expect((await post(h.app, "/api/agents/nope/opened")).status).toBe(204);
  expect(h.marks).toEqual([]);
});

test("a refused open is a status the client can log, with the reason", async () => {
  const h = harness(core(), new Unsupported("this is the demo"));
  const res = await post(h.app, "/api/agents/core:t1/opened");
  expect(res.status).toBe(409);
});

test("a herdr agent's ack is unchanged", async () => {
  const h = harness(herdr());
  expect((await post(h.app, "/api/agents/w1:p1/ack")).status).toBe(200);
  expect(h.store.snapshot()[0]!.acknowledgedAt).toBe(NOW);
  expect(h.marks).toEqual([]);
});

test("GET /opened does not exist", async () => {
  const h = harness(core());
  const res = await h.app.request("/api/agents/core:t1/opened");
  expect(h.marks).toEqual([]);
  expect(res.status).not.toBe(204);
});

test("presence never writes seen: the presence and socket layers have no way to", async () => {
  // `ws/serve.ts` takes no `actions` dependency at all, so a presence message
  // cannot reach `markSeen`; this pins that nothing there names it.
  for (const f of ["src/server/ws/serve.ts", "src/server/state/presence.ts", "src/server/notify/notifier.ts"]) {
    expect(await Bun.file(f).text()).not.toMatch(/markSeen/);
  }
});
