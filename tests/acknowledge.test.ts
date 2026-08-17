import { expect, test } from "bun:test";
import { AgentStore } from "@server/state/store";
import { sectionFor, type Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "done", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project",
    stateSince: NOW, updatedAt: NOW, acknowledgedAt: null, ...over,
  };
}

test("a done agent is in needs-you until acknowledged", () => {
  expect(sectionFor(agent())).toBe("needs-you");
  expect(sectionFor(agent({ acknowledgedAt: NOW }))).toBe("idle");
});

test("acknowledging a non-done agent changes nothing", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent({ state: "working" })], NOW);
  expect(store.acknowledge("w1:p1", NOW)).toBeNull();
  expect(store.snapshot()[0]!.acknowledgedAt).toBeNull();
});

test("acknowledge stamps the flag and reports an upsert", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const d = store.acknowledge("w1:p1", NOW + 5);
  expect(d!.upserted[0]!.acknowledgedAt).toBe(NOW + 5);
});

test("acknowledging twice is a no-op the second time", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  store.acknowledge("w1:p1", NOW + 5);
  expect(store.acknowledge("w1:p1", NOW + 9)).toBeNull();
});

test("acknowledging an unknown agent returns null", () => {
  const store = new AgentStore("dev-box");
  expect(store.acknowledge("nope:p1", NOW)).toBeNull();
});

// The reconcile re-sends every agent every 30s. If it dropped the flag, an
// acknowledged card would reappear in Needs you within half a minute.
test("a reconcile preserves the acknowledge flag", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  store.acknowledge("w1:p1", NOW + 5);
  store.replaceAll([agent()], NOW + 30_000);
  expect(store.snapshot()[0]!.acknowledgedAt).toBe(NOW + 5);
});

// Acknowledging means "I have dealt with this finish". A new finish is new news.
test("leaving done clears the acknowledge flag", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  store.acknowledge("w1:p1", NOW + 5);
  store.replaceAll([agent({ state: "working" })], NOW + 10);
  expect(store.snapshot()[0]!.acknowledgedAt).toBeNull();
});
