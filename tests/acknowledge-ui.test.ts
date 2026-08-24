import { expect, test } from "bun:test";
import { showAcknowledge } from "@web/components/AgentCard";
import type { Agent } from "@shared/types";

const base: Agent = {
  hostId: "dev-box", agentId: "w1:p1", name: "docs-cleanup", task: "Tidy the README",
  state: "done", workspaceId: "w1", workspaceLabel: null, cwd: "/srv/project", harness: "claude",
  stateSince: 1, updatedAt: 1, acknowledgedAt: null, hasJournal: false,
};

test("offered on a fresh done agent", () => {
  expect(showAcknowledge(base)).toBe(true);
});

test("not offered once acknowledged", () => {
  expect(showAcknowledge({ ...base, acknowledgedAt: 2 })).toBe(false);
});

// Dismissing a blocked agent would hide something that still needs an answer.
test("never offered on a blocked agent", () => {
  expect(showAcknowledge({ ...base, state: "blocked" })).toBe(false);
});
