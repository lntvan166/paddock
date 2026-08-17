import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "blocked", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project",
    stateSince: NOW, updatedAt: NOW, acknowledgedAt: null, ...over,
  };
}

function harness(a: Agent = agent()) {
  const store = new AgentStore("dev-box");
  store.replaceAll([a], NOW);
  const calls: string[] = [];
  const actions = {
    async readOutput() { calls.push("readOutput"); return { lines: ["out"], source: "visible" as const }; },
    async readDetection() { calls.push("readDetection"); return "Proceed?\n ❯ 1. Yes\n   2. No\n"; },
    async sendOptionKey(_t: string, k: string) { calls.push(`key:${k}`); },
    async sendReply(_t: string, text: string) { calls.push(`reply:${text}`); },
    async waitUntilUnblocked() { calls.push("wait"); },
  };
  const hub = new Hub({ now: () => NOW });
  const app = createApp({
    store, hub, actions, now: () => NOW,
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW }),
  });
  return { app, store, calls };
}

const post = (app: any, path: string, body?: object) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

test("output returns lines and the source used", async () => {
  const { app } = harness();
  const res = await post(app, "/api/agents/w1:p1/output");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ lines: ["out"], source: "visible" });
});

test("prompt returns parsed options", async () => {
  const { app } = harness();
  const body = await (await post(app, "/api/agents/w1:p1/prompt")).json();
  expect(body.options).toHaveLength(2);
  expect(body.options[0]).toEqual({ key: "1", label: "Yes", selected: true });
});

test("answering by key sends the digit and confirms", async () => {
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w1:p1/answer", { key: "2" });
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toEqual(["key:2", "wait"]);
});

test("answering by text goes through agent.prompt", async () => {
  const { app, calls } = harness();
  await post(app, "/api/agents/w1:p1/answer", { text: "run tests first" });
  expect(calls).toEqual(["reply:run tests first", "wait"]);
});

// THE scope guard. agent.prompt accepts arbitrary text, so this is enforced
// against the store rather than trusted to the UI.
test("answering a NON-blocked agent is refused, and nothing is sent", async () => {
  const { app, calls } = harness(agent({ state: "working" }));
  const res = await post(app, "/api/agents/w1:p1/answer", { key: "1" });
  expect(res.status).toBe(409);
  expect((await res.json()).ok).toBe(false);
  expect(calls).toEqual([]);
});

test("answering an unknown agent is refused", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/nope:p1/answer", { key: "1" })).status).toBe(404);
  expect(calls).toEqual([]);
});

test("an answer with neither key nor text is rejected", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/w1:p1/answer", {})).status).toBe(400);
  expect(calls).toEqual([]);
});

test("ack marks a done agent and is refused for others", async () => {
  const done = harness(agent({ state: "done" }));
  expect((await post(done.app, "/api/agents/w1:p1/ack")).status).toBe(200);
  expect(done.store.snapshot()[0]!.acknowledgedAt).toBe(NOW);

  const blocked = harness();
  expect((await post(blocked.app, "/api/agents/w1:p1/ack")).status).toBe(409);
});

test("a failed action reports ok:false rather than throwing", async () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app2 = createApp({
    store, hub: new Hub({ now: () => NOW }),
    actions: {
      async readOutput() { return { lines: [], source: "visible" as const }; },
      async readDetection() { return ""; },
      async sendOptionKey() { throw new Error("herdr said no"); },
      async sendReply() {}, async waitUntilUnblocked() {},
    },
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW }),
  });
  const res = await post(app2, "/api/agents/w1:p1/answer", { key: "1" });
  expect(res.status).toBe(502);
  expect((await res.json()).detail).toContain("herdr said no");
});
