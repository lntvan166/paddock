import { expect, test } from "bun:test";
import { Hub, type HubClient } from "@server/ws/hub";
import type { Agent, ServerMessage } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "working", workspaceId: "w1",
    workspaceLabel: null, cwd: "/srv/project", stateSince: NOW, updatedAt: NOW,
    acknowledgedAt: null, ...over,
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

test("a QUIET hub still proves the link is alive inside the staleness window", async () => {
  // The whole-branch defect: nothing on the server sends anything when
  // nothing is happening — flush() returns early with an empty queue, and the
  // supervisor emits a delta only when a reconcile changed something. Idle
  // agents overnight meant exactly zero traffic, and the UI declared a
  // healthy link stale at T+60s.
  const hub = new Hub({ heartbeatMs: 20 });
  const { client, sent } = fakeClient();
  hub.add(client);

  hub.startHeartbeat();
  try {
    // No queue(), no flush() — a completely quiet system.
    await new Promise((resolve) => setTimeout(resolve, 70));
  } finally {
    hub.stopHeartbeat();
  }

  expect(sent.length).toBeGreaterThan(0);
  for (const msg of sent) expect(msg.type).toBe("heartbeat");
});

test("the default heartbeat interval sits comfortably inside the 60s staleness threshold", () => {
  // A heartbeat slower than the client's threshold would be worse than none:
  // it would flap the banner instead of removing it.
  expect(new Hub().heartbeatIntervalMs).toBeLessThan(60_000 / 2);
});

test("a heartbeat carries no agent data", () => {
  // Asserted by ABSENCE of agent fields rather than by exact equality: the
  // frame also carries the build id, and pinning the whole object made adding
  // that look like a regression in a test whose subject is agent data.
  const hub = new Hub({ now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.sendHeartbeat();
  expect(sent).toHaveLength(1);
  const msg = sent[0] as Record<string, unknown>;
  expect(msg.type).toBe("heartbeat");
  expect(msg.serverTime).toBe(NOW);
  for (const field of ["agents", "upserted", "removedIds", "hostId"]) {
    expect(msg[field]).toBeUndefined();
  }
});

test("a heartbeat carries the build id, so an open tab can notice it is stale", () => {
  // `index.html` is served no-cache, which fixes a FRESH load and does nothing
  // for a tab already open — the tab an operator leaves running on a phone.
  const hub = new Hub({ now: () => NOW, build: () => "index-ABC123.js" });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.sendHeartbeat();
  expect((sent[0] as Record<string, unknown>).build).toBe("index-ABC123.js");
});

test("with no built UI the build id is null, not a made-up value", () => {
  // Dev mode serves unhashed assets. Inventing an id would make every client
  // believe a new build had landed, on every heartbeat, forever.
  const hub = new Hub({ now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.sendHeartbeat();
  expect((sent[0] as Record<string, unknown>).build).toBeNull();
});

test("a heartbeat carries latestKnown too, so a reconnecting tab still learns of an update", () => {
  // Same reasoning as `build` above: the hub does not know or care that this
  // came from a once-a-day GitHub check cached on disk, only that it is read
  // fresh on every frame.
  const hub = new Hub({ now: () => NOW, latestKnown: () => "9.9.9" });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.sendHeartbeat();
  expect((sent[0] as Record<string, unknown>).latestKnown).toBe("9.9.9");
});

test("with no latestKnown injected, the heartbeat reports null, not undefined", () => {
  const hub = new Hub({ now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.sendHeartbeat();
  expect((sent[0] as Record<string, unknown>).latestKnown).toBeNull();
});

test("a snapshot carries latestKnown too, so a fresh connect learns of an update immediately", () => {
  const hub = new Hub({ now: () => NOW, latestKnown: () => "9.9.9" });
  const { client, sent } = fakeClient();
  hub.sendSnapshot(client, "dev-box", []);
  expect((sent[0] as Record<string, unknown>).latestKnown).toBe("9.9.9");
});

test("startHeartbeat is idempotent — a second call does not double the rate", async () => {
  const hub = new Hub({ heartbeatMs: 20 });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.startHeartbeat();
  hub.startHeartbeat();
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    hub.stopHeartbeat();
  }
  // Two intervals in 50ms at 20ms each; a doubled timer would give ~4.
  expect(sent.length).toBeLessThanOrEqual(3);
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
