import { expect, test } from "bun:test";
import { toAgents } from "@server/herdr/adapter";
import { toSpaceTree } from "@server/herdr/tree";
import type { HerdrSessionSnapshot, HerdrAgentRaw } from "@shared/herdr-api";
import snapshot from "./fixtures/session-snapshot.json";

const NOW = 1_700_000_000_000;
const snap = snapshot as unknown as HerdrSessionSnapshot;

test("a pane with no agent is in the tree but never in the agent list", () => {
  const inTree = toSpaceTree(snap, NOW).spaces
    .flatMap((s) => s.tabs).flatMap((t) => t.panes)
    .filter((p) => p.harness === null).map((p) => p.paneId);
  expect(inTree).toContain("w3:p1");

  const agents = toAgents(snap.agents, { hostId: "dev-box", labels: new Map(), now: NOW });
  expect(agents.map((a) => a.agentId)).not.toContain("w3:p1");
});

test("every agent in the tree is also an agent in the store's view", () => {
  const treeAgents = toSpaceTree(snap, NOW).spaces
    .flatMap((s) => s.tabs).flatMap((t) => t.panes)
    .filter((p) => p.harness !== null).map((p) => p.paneId).sort();
  const storeAgents = toAgents(snap.agents, { hostId: "dev-box", labels: new Map(), now: NOW })
    .map((a) => a.agentId).sort();
  expect(treeAgents).toEqual(storeAgents);
});

test("a harness-less row arriving in agent.list is rejected, not adopted", () => {
  // herdr types `agent` as string | null | undefined, so agent.list CAN carry a
  // row for a pane with no harness. adapter.ts's `if (!rawAgent.agent) return
  // null` is what rejects it, and this is the test that proves it does —
  // the shared fixture's agents array omits the shell pane entirely, so
  // nothing else in the suite exercises that branch.
  const base = {
    pane_id: "w3:p1",
    workspace_id: "w3",
    tab_id: "w3:t1",
    terminal_id: "t_shell",
    agent_status: "idle" as const,
    cwd: "/srv/project",
    focused: false,
    revision: 1,
  };
  for (const row of [
    base, // `agent` absent entirely
    { ...base, agent: null }, // explicitly null
    { ...base, agent: "" }, // empty string
  ]) {
    const agents = toAgents([...snap.agents, row] as HerdrAgentRaw[], {
      hostId: "dev-box",
      labels: new Map(),
      now: NOW,
    });
    expect(agents.map((a) => a.agentId)).not.toContain("w3:p1");
    expect(agents).toHaveLength(snap.agents.length);
  }
});
