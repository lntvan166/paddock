import { expect, test } from "bun:test";
import { groupAgents } from "@web/components/Section";
import { applyMessage, type ClientState } from "@web/store";
import { SECTION_ORDER, type Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(name: string, state: Agent["state"], stateSince = NOW): Agent {
  return {
    hostId: "dev-box", agentId: name, name, task: `task for ${name}`, state,
    workspaceId: "w1", workspaceLabel: null, cwd: "/srv/project",
    stateSince, updatedAt: stateSince, acknowledgedAt: null,
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

test("within Needs you, most-recently-changed first (spec §6)", () => {
  const g = groupAgents([
    agent("old-blocker", "blocked", NOW - 600_000),
    agent("new-blocker", "blocked", NOW - 1_000),
  ]);
  expect(g["needs-you"].map((x) => x.name)).toEqual(["new-blocker", "old-blocker"]);
});

test("triage order survives a delta, not just the snapshot", () => {
  // The whole-branch defect: the server sorts only what it sends in a
  // snapshot, and the client merges deltas into a Map, where setting an
  // existing key keeps its ORIGINAL position. So "A blocked ten minutes ago,
  // B goes blocked now" rendered [A, B] — oldest first — for the rest of the
  // session. Grouping must re-sort, or this reverts.
  const empty: ClientState = { agents: [], hostId: null, connected: false, lastMessageAt: null, build: null, updateAvailable: false, latestKnown: null };
  const withSnapshot = applyMessage(empty, {
    type: "snapshot",
    hostId: "dev-box",
    agents: [agent("a-blocked-ages-ago", "blocked", NOW - 600_000), agent("b-working", "working")],
    serverTime: NOW,
  });
  const afterDelta = applyMessage(withSnapshot, {
    type: "delta",
    upserted: [agent("b-working", "blocked", NOW)],
    removedIds: [],
    serverTime: NOW + 1,
  });

  // Merge order alone would be ["a-blocked-ages-ago", "b-working"].
  expect(groupAgents(afterDelta.agents)["needs-you"].map((x) => x.name))
    .toEqual(["b-working", "a-blocked-ages-ago"]);
});

test("a section move via delta lands the agent in its new section, ordered", () => {
  const g = groupAgents([
    agent("still-working", "working", NOW - 5_000),
    agent("just-blocked", "blocked", NOW),
    agent("long-idle", "idle", NOW - 900_000),
  ]);
  expect(g["needs-you"].map((x) => x.name)).toEqual(["just-blocked"]);
  expect(g.working.map((x) => x.name)).toEqual(["still-working"]);
  expect(g.idle.map((x) => x.name)).toEqual(["long-idle"]);
});
