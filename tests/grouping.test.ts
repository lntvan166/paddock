import { expect, test } from "bun:test";
import { groupAgents, SECTION_TITLES } from "@web/components/Section";
import { applyMessage, type ClientState } from "@web/store";
import { SECTION_ORDER, type Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(name: string, state: Agent["state"], stateSince = NOW): Agent {
  return {
    hostId: "dev-box", agentId: name, name, task: `task for ${name}`, state,
    workspaceId: "w1", workspaceLabel: null, cwd: "/srv/project", harness: "claude",
    stateSince, stateSinceExact: true, updatedAt: stateSince, acknowledgedAt: null, hasJournal: false,
  };
}

test("a stuck agent and a finished one no longer share a section", () => {
  // They are different urgencies. One wants a decision before work continues;
  // the other is news you have not read. Sharing a section made the unread
  // news compete with the decision.
  const g = groupAgents([agent("a", "blocked"), agent("b", "done")]);
  expect(g["needs-you"].map((x) => x.name)).toEqual(["a"]);
  expect(g["ready-unseen"].map((x) => x.name)).toEqual(["b"]);
});

test("an acknowledged finish drops to idle", () => {
  const acked = { ...agent("c", "done"), acknowledgedAt: NOW };
  const g = groupAgents([acked]);
  expect(g["ready-unseen"]).toEqual([]);
  expect(g.idle.map((x) => x.name)).toEqual(["c"]);
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
  expect(Object.keys(g)).toEqual(["needs-you", "ready-unseen", "working", "idle"]);
});

test("SECTION_ORDER is pinned — the operator always knows where to look", () => {
  expect(SECTION_ORDER).toEqual(["needs-you", "ready-unseen", "working", "idle"]);
});

test("the ready section is titled in paddock's plainer register", () => {
  // "Done" is rejected: `done` is also a STATE, and an acknowledged done
  // renders under Idle — a label that contradicted the state name in one of
  // its two cases would be worse than a new word.
  expect(SECTION_TITLES["ready-unseen"]).toBe("Ready");
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
  const empty: ClientState = { agents: [], hostId: null, connected: false, lastMessageAt: null, build: null, updateAvailable: false, latestKnown: null, managedBy: null, treeStaleAt: 0, spacesAvailable: false };
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
