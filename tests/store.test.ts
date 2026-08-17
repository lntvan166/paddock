import { expect, test } from "bun:test";
import { AgentStore } from "@server/state/store";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box",
    agentId: "w1:p1",
    name: "api-refactor",
    task: "Extract auth middleware",
    state: "working",
    workspaceId: "w1",
    workspaceLabel: null,
    cwd: "/srv/project",
    stateSince: NOW,
    updatedAt: NOW,
    acknowledgedAt: null,
    ...over,
  };
}

test("replaceAll reports newly added agents as upserted", () => {
  const store = new AgentStore("dev-box");
  const d = store.replaceAll([agent()], NOW);
  expect(d.upserted).toHaveLength(1);
  expect(d.removedIds).toEqual([]);
});

test("replaceAll reports no upserts when nothing changed", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const d = store.replaceAll([agent()], NOW + 1000);
  expect(d.upserted).toEqual([]);
});

test("replaceAll preserves the original stateSince for an unchanged state", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  store.replaceAll([agent({ stateSince: NOW + 9000 })], NOW + 9000);
  expect(store.snapshot()[0]!.stateSince).toBe(NOW);
});

test("replaceAll reports a state change as an upsert and restamps stateSince", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const d = store.replaceAll([agent({ state: "blocked", stateSince: NOW + 2000 })], NOW + 2000);
  expect(d.upserted).toHaveLength(1);
  expect(d.upserted[0]!.stateSince).toBe(NOW + 2000);
});

test("replaceAll reports disappeared agents as removed", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent(), agent({ agentId: "w2:p1", name: "docs-cleanup" })], NOW);
  const d = store.replaceAll([agent()], NOW + 1000);
  expect(d.removedIds).toEqual(["w2:p1"]);
});

test("applyEvent mutates a known agent and returns it", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const out = store.applyEvent("w1:p1", (p) => ({ ...p, state: "blocked" }));
  expect(out!.state).toBe("blocked");
});

test("applyEvent returns null for an unknown agent", () => {
  const store = new AgentStore("dev-box");
  expect(store.applyEvent("nope:p1", (p) => p)).toBeNull();
});

test("remove drops the agent and reports it as removed", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const d = store.remove("w1:p1");
  expect(d!.removedIds).toEqual(["w1:p1"]);
  expect(store.snapshot()).toEqual([]);
});

test("removing an already-gone agent returns null, so no empty delta is sent", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  store.remove("w1:p1");
  expect(store.remove("w1:p1")).toBeNull();
});

test("snapshot sorts needs-you first, then working, then idle", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll(
    [
      agent({ agentId: "a", name: "idle-one", state: "idle" }),
      agent({ agentId: "b", name: "working-one", state: "working" }),
      agent({ agentId: "c", name: "blocked-one", state: "blocked" }),
    ],
    NOW,
  );
  expect(store.snapshot().map((a) => a.name)).toEqual(["blocked-one", "working-one", "idle-one"]);
});

test("snapshot orders needs-you by most recent state change first", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll(
    [
      agent({ agentId: "a", name: "older", state: "blocked", stateSince: NOW }),
      agent({ agentId: "b", name: "newer", state: "done", stateSince: NOW + 5000 }),
    ],
    NOW,
  );
  expect(store.snapshot().map((a) => a.name)).toEqual(["newer", "older"]);
});
