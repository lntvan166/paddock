import { expect, test } from "bun:test";
import { groupAgents } from "@web/components/Section";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(name: string, state: Agent["state"]): Agent {
  return {
    hostId: "dev-box", agentId: name, name, task: `task for ${name}`, state,
    workspaceId: "w1", workspaceLabel: null, cwd: "/srv/project",
    stateSince: NOW, updatedAt: NOW,
  };
}

test("blocked and done both land in needs-you", () => {
  const g = groupAgents([agent("a", "blocked"), agent("b", "done")]);
  expect(g["needs-you"].map((x) => x.name)).toEqual(["a", "b"]);
});

test("working and idle are separated", () => {
  const g = groupAgents([agent("c", "working"), agent("d", "idle")]);
  expect(g.working.map((x) => x.name)).toEqual(["c"]);
  expect(g.idle.map((x) => x.name)).toEqual(["d"]);
});

test("every section key exists even when empty", () => {
  const g = groupAgents([]);
  expect(Object.keys(g).sort()).toEqual(["idle", "needs-you", "working"]);
});
