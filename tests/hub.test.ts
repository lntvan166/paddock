import { expect, test } from "bun:test";
import { Hub, type HubClient } from "@server/ws/hub";
import type { Agent, ServerMessage } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "working", workspaceId: "w1",
    workspaceLabel: null, cwd: "/srv/project", stateSince: NOW, updatedAt: NOW, ...over,
  };
}

function fakeClient() {
  const sent: ServerMessage[] = [];
  const client: HubClient = { send: (d) => sent.push(JSON.parse(d)) };
  return { client, sent };
}

test("sendSnapshot delivers a snapshot to one client", () => {
  const hub = new Hub({ now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.sendSnapshot(client, "dev-box", [agent()]);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.type).toBe("snapshot");
});

test("queued deltas are not sent until flush", () => {
  const hub = new Hub({ coalesceMs: 100, now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.queue({ upserted: [agent()], removedIds: [] });
  expect(sent).toHaveLength(0);
  hub.flush();
  expect(sent).toHaveLength(1);
});

test("a burst for one agent coalesces to its latest value", () => {
  const hub = new Hub({ coalesceMs: 100, now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.queue({ upserted: [agent({ state: "working" })], removedIds: [] });
  hub.queue({ upserted: [agent({ state: "idle" })], removedIds: [] });
  hub.queue({ upserted: [agent({ state: "working" })], removedIds: [] });
  hub.flush();
  expect(sent).toHaveLength(1);
  const msg = sent[0]!;
  if (msg.type !== "delta") throw new Error("expected a delta");
  expect(msg.upserted).toHaveLength(1);
  expect(msg.upserted[0]!.state).toBe("working");
});

test("a removal supersedes a queued upsert for the same agent", () => {
  const hub = new Hub({ coalesceMs: 100, now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.queue({ upserted: [agent()], removedIds: [] });
  hub.queue({ upserted: [], removedIds: ["w1:p1"] });
  hub.flush();
  const msg = sent[0]!;
  if (msg.type !== "delta") throw new Error("expected a delta");
  expect(msg.upserted).toEqual([]);
  expect(msg.removedIds).toEqual(["w1:p1"]);
});

test("flush with nothing queued sends nothing", () => {
  const hub = new Hub({ now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.flush();
  expect(sent).toHaveLength(0);
});

test("a removed client receives nothing", () => {
  const hub = new Hub({ now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.remove(client);
  hub.queue({ upserted: [agent()], removedIds: [] });
  hub.flush();
  expect(sent).toHaveLength(0);
  expect(hub.clientCount).toBe(0);
});

test("a delta reaches every connected client", () => {
  const hub = new Hub({ now: () => NOW });
  const a = fakeClient(); const b = fakeClient();
  hub.add(a.client); hub.add(b.client);
  hub.queue({ upserted: [agent()], removedIds: [] });
  hub.flush();
  expect(a.sent).toHaveLength(1);
  expect(b.sent).toHaveLength(1);
});

test("an unflushed queue auto-flushes once the coalescing window elapses", async () => {
  const hub = new Hub({ coalesceMs: 20 });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.queue({ upserted: [agent()], removedIds: [] });
  expect(sent).toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(sent).toHaveLength(1);
});

test("a rapid burst for one agent auto-flushes once, carrying its final value", async () => {
  const hub = new Hub({ coalesceMs: 20 });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.queue({ upserted: [agent({ state: "working" })], removedIds: [] });
  hub.queue({ upserted: [agent({ state: "idle" })], removedIds: [] });
  hub.queue({ upserted: [agent({ state: "working" })], removedIds: [] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(sent).toHaveLength(1);
  const msg = sent[0]!;
  if (msg.type !== "delta") throw new Error("expected a delta");
  expect(msg.upserted).toHaveLength(1);
  expect(msg.upserted[0]!.state).toBe("working");
});

test("a burst merges an upsert of one agent with a removal of a different agent", () => {
  const hub = new Hub({ coalesceMs: 100, now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.queue({ upserted: [agent({ agentId: "w1:p1" })], removedIds: [] });
  hub.queue({ upserted: [], removedIds: ["w1:p2"] });
  hub.flush();
  expect(sent).toHaveLength(1);
  const msg = sent[0]!;
  if (msg.type !== "delta") throw new Error("expected a delta");
  expect(msg.upserted.map((a) => a.agentId)).toEqual(["w1:p1"]);
  expect(msg.removedIds).toEqual(["w1:p2"]);
});
