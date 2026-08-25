import { expect, test } from "bun:test";
import { toAgents } from "@server/herdr/adapter";
import { toSpaceTree } from "@server/herdr/tree";
import type { HerdrSessionSnapshot } from "@shared/herdr-api";
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
