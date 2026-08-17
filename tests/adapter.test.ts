import { expect, test } from "bun:test";
import { applyStatusEvent, toAgent } from "@server/herdr/adapter";
import type { HerdrAgentRaw } from "@shared/herdr-api";

const NOW = 1_700_000_000_000;
const ctx = { hostId: "dev-box", labels: new Map([["w1", "api work"]]), now: NOW };

function raw(over: Partial<HerdrAgentRaw> = {}): HerdrAgentRaw {
  return {
    agent: "claude",
    agent_status: "working",
    cwd: "/srv/project",
    focused: false,
    name: "api-refactor",
    pane_id: "w1:p1",
    revision: 1,
    tab_id: "w1:t1",
    terminal_id: "t1",
    terminal_title: "* Extract auth middleware",
    terminal_title_stripped: "Extract auth middleware",
    workspace_id: "w1",
    ...over,
  };
}

test("uses name as the label and terminal_title_stripped as the task", () => {
  const a = toAgent(raw(), ctx)!;
  expect(a.name).toBe("api-refactor");
  expect(a.task).toBe("Extract auth middleware");
});

test("REGRESSION: agents sharing a cwd get distinct labels", () => {
  const a = toAgent(raw({ pane_id: "w1:p1", name: "api-refactor" }), ctx)!;
  const b = toAgent(raw({ pane_id: "w2:p1", name: "flaky-test-fix" }), ctx)!;
  expect(a.cwd).toBe(b.cwd);
  expect(a.name).not.toBe(b.name);
  expect(a.name).not.toBe("project"); // never basename(cwd)
});

test("falls back to the pane id when name is missing, never to cwd", () => {
  const a = toAgent(raw({ name: null }), ctx)!;
  expect(a.name).toBe("w1:p1");
  expect(a.name).not.toBe("project");
});

test("filters out panes with status unknown", () => {
  expect(toAgent(raw({ agent_status: "unknown" }), ctx)).toBeNull();
});

test("filters out panes with no agent field", () => {
  expect(toAgent(raw({ agent: null }), ctx)).toBeNull();
});

test("joins the workspace label by workspace_id", () => {
  expect(toAgent(raw(), ctx)!.workspaceLabel).toBe("api work");
  expect(toAgent(raw({ workspace_id: "w9" }), ctx)!.workspaceLabel).toBeNull();
});

test("stamps stateSince from the supplied clock", () => {
  expect(toAgent(raw(), ctx)!.stateSince).toBe(NOW);
});

test("a status event preserves name and refreshes stateSince only on change", () => {
  const prev = toAgent(raw(), ctx)!;
  const same = applyStatusEvent(prev, { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" }, NOW + 5000);
  expect(same.name).toBe("api-refactor");
  expect(same.stateSince).toBe(NOW);

  const moved = applyStatusEvent(prev, { pane_id: "w1:p1", workspace_id: "w1", agent_status: "blocked" }, NOW + 5000);
  expect(moved.state).toBe("blocked");
  expect(moved.stateSince).toBe(NOW + 5000);
});

test("a status event updates the task when it carries a title", () => {
  const prev = toAgent(raw(), ctx)!;
  const next = applyStatusEvent(
    prev,
    { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working", title: "* Rename the module" },
    NOW + 1,
  );
  expect(next.task).toBe("Rename the module");
});

// The push path is PRIMARY, not just the 30s reconcile: an agent acknowledged
// while done, then moved off done by a live event (not a reconcile), must not
// carry a stale flag into its next finish.
test("a status event moving an acknowledged agent off done clears the flag", () => {
  const prev = { ...toAgent(raw({ agent_status: "done" }), ctx)!, acknowledgedAt: NOW };
  const next = applyStatusEvent(prev, { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" }, NOW + 5000);
  expect(next.acknowledgedAt).toBeNull();
});
