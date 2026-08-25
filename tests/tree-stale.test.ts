import { expect, test } from "bun:test";
import { applyMessage } from "@web/store";
import { Hub } from "@server/ws/hub";
import type { ClientState } from "@web/store";

const NOW = 1_700_000_000_000;

const base = (): ClientState => ({
  agents: [], hostId: null, connected: true, lastMessageAt: NOW,
  build: null, updateAvailable: false, latestKnown: null, managedBy: null,
  treeStaleAt: 0,
});

test("a tree-stale frame does not crash the delta fall-through", () => {
  const next = applyMessage(base(), { type: "tree-stale", serverTime: NOW + 5 });
  expect(next.treeStaleAt).toBe(NOW + 5);
});

test("tree-stale never touches the agent list", () => {
  const state = { ...base(), agents: [{ agentId: "w1:p1" } as never] };
  const next = applyMessage(state, { type: "tree-stale", serverTime: NOW + 5 });
  expect(next.agents).toBe(state.agents);
});

test("tree-stale counts as liveness", () => {
  const next = applyMessage(base(), { type: "tree-stale", serverTime: NOW + 9 });
  expect(next.lastMessageAt).toBe(NOW + 9);
});

test("the hub sends one tree-stale frame per call", () => {
  const sent: string[] = [];
  const hub = new Hub({ now: () => NOW });
  hub.add({ send: (d) => sent.push(d) });
  sent.length = 0; // ignore anything `add` may emit on join
  hub.queueTreeStale();
  const frames = sent.map((s) => JSON.parse(s)).filter((f) => f.type === "tree-stale");
  expect(frames).toHaveLength(1);
});
