import { expect, test } from "bun:test";
import { DEFAULT_READ_LINES, MAX_READ_LINES } from "@server/herdr/actions";
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
    // The line count is recorded, not just the call: it is the only
    // client-supplied value that reaches a herdr parameter, so what arrives
    // here is the thing under test.
    async readOutput(_t: string, _s: Agent["state"], lines?: number) {
      calls.push(`readOutput:${lines}`);
      return { lines: ["out"], source: "visible" as const };
    },
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

// A client-supplied `lines` used to be cast, never checked: `{"lines": 1e9}`
// asked herdr for a billion lines and buffered the answer in this process,
// and `{"lines": "60"}` put a string into a herdr numeric param. Spec §5 says
// output is "bounded by a line count" — the bound is paddock's.
test("an out-of-range lines value is clamped to the read ceiling", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/w1:p1/output", { lines: 1e9 })).status).toBe(200);
  expect(calls).toEqual([`readOutput:${MAX_READ_LINES}`]);
});

test("a non-numeric lines value falls back to the default", async () => {
  const { app, calls } = harness();
  await post(app, "/api/agents/w1:p1/output", { lines: "60" });
  await post(app, "/api/agents/w1:p1/output", { lines: { n: 60 } });
  await post(app, "/api/agents/w1:p1/output", { lines: -5 });
  await post(app, "/api/agents/w1:p1/output", {});
  expect(calls).toEqual(Array(4).fill(`readOutput:${DEFAULT_READ_LINES}`));
});

test("a valid lines value is passed through unchanged", async () => {
  const { app, calls } = harness();
  await post(app, "/api/agents/w1:p1/output", { lines: 40 });
  expect(calls).toEqual(["readOutput:40"]);
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

// Spec §6 calls the key "the option's digit", and states there is no
// general-purpose send endpoint. A control sequence is a strictly larger
// capability than the free text `{text}` already permits.
test("a non-digit key is refused, and nothing is sent to herdr", async () => {
  for (const key of ["C-c", "Escape", "1;rm -rf /", "0x2", " 2"]) {
    const { app, calls } = harness();
    const res = await post(app, "/api/agents/w1:p1/answer", { key });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    expect(calls).toEqual([]);
  }
});

// A JSON number passes a plain truthiness check and reaches agent.send_keys
// as a non-string.
test("a numeric key is refused rather than forwarded as a non-string", async () => {
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w1:p1/answer", { key: 2 });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a numeric text is refused rather than forwarded as a non-string", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/w1:p1/answer", { text: 7 })).status).toBe(400);
  expect(calls).toEqual([]);
});

test("a two-digit option key is still accepted", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/w1:p1/answer", { key: "10" })).status).toBe(200);
  expect(calls).toEqual(["key:10", "wait"]);
});

test("ack marks a done agent and is refused for others", async () => {
  const done = harness(agent({ state: "done" }));
  expect((await post(done.app, "/api/agents/w1:p1/ack")).status).toBe(200);
  expect(done.store.snapshot()[0]!.acknowledgedAt).toBe(NOW);

  const blocked = harness();
  expect((await post(blocked.app, "/api/agents/w1:p1/ack")).status).toBe(409);
});

// Spec §7: nothing is sent to herdr for an acknowledge. Registering /ack
// inside `if (deps.actions)` made it 404 in `--demo` — where the seeded `done`
// agent renders a Dismiss button — so the one v2 feature that needs no herdr
// was the one broken in the mode the README takes screenshots from.
test("ack works with no herdr actions wired up at all, as in --demo", async () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent({ state: "done" })], NOW);
  const app = createApp({
    store, hub: new Hub({ now: () => NOW }), now: () => NOW,
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW }),
  });
  const res = await post(app, "/api/agents/w1:p1/ack");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(store.snapshot()[0]!.acknowledgedAt).toBe(NOW);
});

// The herdr-backed routes must still be absent there — they have nothing to
// call, and a 404 is honest where a synthetic success would not be.
test("the herdr-backed routes stay absent with no actions", async () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app = createApp({
    store, hub: new Hub({ now: () => NOW }), now: () => NOW,
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW }),
  });
  for (const route of ["output", "prompt", "answer"]) {
    expect((await post(app, `/api/agents/w1:p1/${route}`, { key: "1" })).status).toBe(404);
  }
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
