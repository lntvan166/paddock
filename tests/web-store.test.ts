import { expect, test } from "bun:test";
import { applyMessage, backoffMs, isStale, type ClientState } from "@web/store";
import type { Agent, ServerMessage } from "@shared/types";
import { wsUrlFrom } from "@web/store";

const NOW = 1_700_000_000_000;
const EMPTY: ClientState = { agents: [], hostId: null, connected: false, lastMessageAt: null };

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "working", workspaceId: "w1",
    workspaceLabel: null, cwd: "/srv/project", stateSince: NOW, updatedAt: NOW, ...over,
  };
}

test("wsUrlFrom uses wss on https", () => {
  expect(wsUrlFrom({ protocol: "https:", host: "paddock.example.com" }))
    .toBe("wss://paddock.example.com/ws");
});

test("wsUrlFrom uses ws on http", () => {
  expect(wsUrlFrom({ protocol: "http:", host: "127.0.0.1:8787" }))
    .toBe("ws://127.0.0.1:8787/ws");
});

test("wsUrlFrom does NOT special-case localhost", () => {
  // A hostname allowlist is how a working dashboard silently becomes a demo screen.
  expect(wsUrlFrom({ protocol: "http:", host: "localhost:8787" }))
    .toBe("ws://localhost:8787/ws");
});

test("a snapshot replaces all state", () => {
  const next = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW,
  });
  expect(next.agents).toHaveLength(1);
  expect(next.hostId).toBe("dev-box");
  expect(next.lastMessageAt).toBe(NOW);
});

test("a snapshot is idempotent", () => {
  const msg: ServerMessage = { type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW };
  expect(applyMessage(applyMessage(EMPTY, msg), msg).agents).toHaveLength(1);
});

test("a delta upserts by agentId", () => {
  const base = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW,
  });
  const next = applyMessage(base, {
    type: "delta", upserted: [agent({ state: "blocked" })], removedIds: [], serverTime: NOW + 1,
  });
  expect(next.agents).toHaveLength(1);
  expect(next.agents[0]!.state).toBe("blocked");
});

test("a delta removes by id", () => {
  const base = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box",
    agents: [agent(), agent({ agentId: "w2:p1", name: "docs-cleanup" })], serverTime: NOW,
  });
  const next = applyMessage(base, {
    type: "delta", upserted: [], removedIds: ["w2:p1"], serverTime: NOW + 1,
  });
  expect(next.agents.map((a) => a.agentId)).toEqual(["w1:p1"]);
});

test("backoff grows and stays within the cap", () => {
  const fixed = () => 0.5;
  expect(backoffMs(0, fixed)).toBeLessThan(backoffMs(3, fixed));
  for (let i = 0; i < 20; i++) expect(backoffMs(i, fixed)).toBeLessThanOrEqual(15_000);
});

test("backoff includes jitter so clients do not retry in lockstep", () => {
  expect(backoffMs(5, () => 0)).not.toBe(backoffMs(5, () => 0.99));
});

test("state is stale when disconnected", () => {
  expect(isStale({ ...EMPTY, connected: false, lastMessageAt: NOW }, NOW + 1)).toBe(true);
});

test("state is stale when no message has arrived within the threshold", () => {
  const s = { ...EMPTY, connected: true, lastMessageAt: NOW };
  expect(isStale(s, NOW + 61_000)).toBe(true);
  expect(isStale(s, NOW + 10_000)).toBe(false);
});
