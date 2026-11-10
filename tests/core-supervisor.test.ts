import { expect, test } from "bun:test";
import { CoreSupervisor, type CoreClientLike } from "@server/herdr-core/supervisor";
import { AgentStore, type Delta } from "@server/state/store";
import { createApp } from "@server/routes";
import { Hub } from "@server/ws/hub";
import type { CoreEvent, CoreSubscribeResult, CoreTerminal, CoreUnknownEvent } from "@shared/herdr-core-api";

const term = (address: string, state = "idle", over: Partial<CoreTerminal> = {}): CoreTerminal => ({
  address, argv: [], cols: 80, rows: 24, created_ms: 1, cwd: "/path/to/proj", labels: {},
  screen: "exact", state: "live", name: `agent-${address}`, title: "", turn: 1,
  status: { state, app: "claude", title: "t", msg: "" } as never, status_ms: 5, ...over,
});

class FakeClient implements CoreClientLike {
  onSnapshot!: (s: CoreSubscribeResult) => void;
  onEvent!: (e: CoreEvent | CoreUnknownEvent) => void;
  onClose!: (r: Error) => void;
  closed = false;
  hello = async () => ({ core: { id: "c", name: "c" }, features: [], framed: false, generation: 1, methods: [] }) as never;
  statusFails = false;
  request = async (method: string) => {
    if (method !== "server.status") throw new Error(`unexpected ${method}`);
    if (this.statusFails) throw new Error("status refused");
    return { core: { id: "c", name: "c" }, version: "9.9.9", pid: 1 } as never;
  };
  subscribe = async (a: any, b: any, c: any) => { this.onSnapshot = a; this.onEvent = b; this.onClose = c; return () => {}; };
  close = () => { this.closed = true; };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
function setup(clients: (FakeClient | null)[], retryMs = 10) {
  const store = new AgentStore("dev-box");
  const deltas: Delta[] = [];
  let i = 0;
  const sup = new CoreSupervisor({ connect: () => clients[Math.min(i++, clients.length - 1)] as never, store, onDelta: (d) => deltas.push(d), retryMs });
  return { store, deltas, sup, attempts: () => i };
}
const ids = (s: AgentStore) => s.snapshot().map((a) => a.agentId).sort();

test("snapshot fills core agents", async () => {
  const c = new FakeClient();
  const { store, sup } = setup([c]);
  sup.start(); await tick();
  c.onSnapshot({ channel: null, seq: 1, terminals: [term("t1"), term("t2")] });
  expect(ids(store)).toEqual(["hc.t1", "hc.t2"]);
  expect(sup.health()).toMatchObject({ connected: true, generation: 1, version: "9.9.9", detail: null });
  sup.stop();
});

test("status event updates one agent and emits a delta", async () => {
  const c = new FakeClient();
  const { store, deltas, sup } = setup([c]);
  sup.start(); await tick();
  c.onSnapshot({ channel: null, seq: 1, terminals: [term("t1", "working"), term("t2")] });
  deltas.length = 0;
  c.onEvent({ seq: 2, terminal: "t1", type: "status", data: { status: { state: "blocked", app: "claude" }, records: {}, reported: true } } as never);
  expect(store.snapshot().find((a) => a.agentId === "hc.t1")!.state).toBe("blocked");
  expect(deltas.length).toBe(1);
  expect(deltas[0]!.upserted.map((a) => a.agentId)).toEqual(["hc.t1"]);
  // An event at or below the snapshot seq is dropped.
  c.onEvent({ seq: 2, terminal: "t1", type: "removed", data: {} } as never);
  expect(store.has("hc.t1")).toBe(true);
  c.onEvent({ seq: 3, terminal: "t3", type: "created", data: term("t3") } as never);
  expect(store.has("hc.t3")).toBe(true);
  c.onEvent({ seq: 4, terminal: "t3", type: "removed", data: {} } as never);
  expect(store.has("hc.t3")).toBe(false);
  sup.stop();
});

test("a missed event replaces core agents from its snapshot", async () => {
  const c = new FakeClient();
  const { store, sup } = setup([c]);
  sup.start(); await tick();
  c.onSnapshot({ channel: null, seq: 1, terminals: [term("t1"), term("t2")] });
  c.onSnapshot({ channel: null, seq: 9, terminals: [term("t2"), term("t4")] });
  expect(ids(store)).toEqual(["hc.t2", "hc.t4"]);
  sup.stop();
});

test("core supervisor drops core agents and reconnects after the socket closes", async () => {
  const a = new FakeClient(); const b = new FakeClient();
  const { store, deltas, sup, attempts } = setup([a, b]);
  sup.start(); await tick();
  a.onSnapshot({ channel: null, seq: 1, terminals: [term("t1")] });
  deltas.length = 0;
  a.onClose(new Error("gone"));
  expect(ids(store)).toEqual([]);
  expect(deltas[0]!.removedIds).toEqual(["hc.t1"]);
  expect(sup.health()).toMatchObject({ connected: false, detail: "gone" });
  await new Promise((r) => setTimeout(r, 40));
  expect(attempts()).toBe(2);
  b.onSnapshot({ channel: null, seq: 1, terminals: [term("t5")] });
  expect(ids(store)).toEqual(["hc.t5"]);
  expect(sup.health().connected).toBe(true);
  sup.stop();
});

test("no core socket means no core agents and one INFO line, not an error loop", async () => {
  const lines: string[] = []; const errs: unknown[] = [];
  const info = console.info; const err = console.error;
  console.info = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { errs.push(a); };
  try {
    const { store, sup, attempts } = setup([null], 5);
    sup.start();
    await new Promise((r) => setTimeout(r, 50));
    sup.stop();
    expect(attempts()).toBeGreaterThan(2);
    expect(ids(store)).toEqual([]);
    expect(lines.filter((l) => l.startsWith("herdr-core: not running"))).toEqual(["herdr-core: not running (no herdr-core socket found)"]);
    expect(errs).toEqual([]);
  } finally { console.info = info; console.error = err; }
});

test("/api/health reports core state", async () => {
  const c = new FakeClient();
  const { store, sup } = setup([c]);
  const health = () => ({
    ok: true, hostId: "dev-box", agents: store.snapshot().length, clients: 0, herdrConnected: true,
    core: sup.health(), app: null, lastEventAt: null, lastNotifyError: null, version: "0.0.0-dev",
    latestKnown: null, managedBy: null, herdrProtocol: null, schemaWarning: null,
  });
  const app = createApp({ store, hub: new Hub(), health });
  const get = async () => (await (await app.request("/api/health")).json()).core;
  sup.start(); await tick();
  expect(await get()).toMatchObject({ connected: false });
  c.onSnapshot({ channel: null, seq: 1, terminals: [term("t1")] });
  expect(await get()).toEqual({ connected: true, lastEventAt: expect.any(Number), generation: 1, version: "9.9.9", detail: null });
  sup.stop();
});

test("a resync that changes only turn or seen emits an upsert", async () => {
  const c = new FakeClient();
  const { deltas, sup } = setup([c]);
  sup.start(); await tick();
  c.onSnapshot({ channel: null, seq: 1, terminals: [term("t1"), term("t2")] });
  deltas.length = 0;
  c.onSnapshot({ channel: null, seq: 2, terminals: [term("t1", "idle", { turn: 2 }), term("t2")] });
  expect(deltas.flatMap((d) => d.upserted.map((a) => a.agentId))).toEqual(["hc.t1"]);
  deltas.length = 0;
  c.onSnapshot({ channel: null, seq: 3, terminals: [term("t1", "idle", { turn: 2 }), term("t2", "idle", { labels: { "herdr.seen": "1" } })] });
  expect(deltas.flatMap((d) => d.upserted.map((a) => a.agentId))).toEqual(["hc.t2"]);
  sup.stop();
});

test("a failed server.status leaves version null and logs once at INFO", async () => {
  const c = new FakeClient(); c.statusFails = true;
  const lines: string[] = [];
  const info = console.info;
  console.info = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const { sup } = setup([c]);
    sup.start(); await tick();
    c.onSnapshot({ channel: null, seq: 1, terminals: [] });
    expect(sup.health().version).toBeNull();
    expect(sup.health().connected).toBe(true);
    expect(lines.filter((l) => l.includes("server.status"))).toHaveLength(1);
    sup.stop();
  } finally { console.info = info; }
});

test("actions get the live client only while the core is connected", async () => {
  const c = new FakeClient();
  const { sup } = setup([c, null], 10_000);
  expect(sup.connection()).toBeNull();
  sup.start(); await tick();
  // Connected but no snapshot yet: not up, so no client for actions.
  expect(sup.connection()).toBeNull();
  c.onSnapshot({ channel: null, seq: 1, terminals: [] });
  expect(sup.connection()).toBe(c);
  c.onClose(new Error("gone"));
  expect(sup.connection()).toBeNull();
  sup.stop();
});
