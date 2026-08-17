import { expect, test } from "bun:test";
import { groupAgents } from "@web/components/Section";
import { SECTION_ORDER, type Agent } from "@shared/types";

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

test("every section key exists even when empty, in fixed triage order", () => {
  const g = groupAgents([]);
  // Not sorted: this pins the real key order groupAgents produces, so a
  // reorder (or a switch to alphabetical) breaks the test instead of passing
  // silently.
  expect(Object.keys(g)).toEqual(["needs-you", "working", "idle"]);
});

test("SECTION_ORDER is pinned — the operator always knows where to look", () => {
  expect(SECTION_ORDER).toEqual(["needs-you", "working", "idle"]);
});
