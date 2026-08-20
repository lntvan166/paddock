import { expect, test } from "bun:test";
import { applyStatusEvent, sessionRefs, toAgent, toAgents } from "@server/herdr/adapter";
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

test("toAgent alone falls back to the pane id — it cannot see collisions", () => {
  // The per-row mapper has no view of the other rows, so it cannot know whether
  // a cwd basename would be unique. `toAgents` is the layer that decides that;
  // this fallback is the last resort for a row with no usable cwd.
  const a = toAgent(raw({ name: null }), ctx)!;
  expect(a.name).toBe("w1:p1");
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

// --- toAgents: the familiar-name fallback -----------------------------------
//
// `basename(cwd)` is allowed ONLY here, and only with disambiguation. The
// failure this project exists to prevent is two rows rendering identically —
// not the use of cwd itself. See docs/gotchas.md.

test("a lone unnamed agent is labelled from its cwd, not its pane id", () => {
  const [a] = toAgents([raw({ name: null })], ctx);
  expect(a!.name).toBe("project");
});

test("an operator-set name is never rewritten", () => {
  const [a] = toAgents([raw({ name: "api-refactor" })], ctx);
  expect(a!.name).toBe("api-refactor");
});

test("REGRESSION: unnamed agents sharing a cwd are both suffixed, never identical", () => {
  const agents = toAgents(
    [
      raw({ name: null, pane_id: "w3:p1", workspace_id: "w3" }),
      raw({ name: null, pane_id: "w3:p2", workspace_id: "w3" }),
    ],
    ctx,
  );
  expect(agents.map((a) => a.name)).toEqual(["project p1", "project p2"]);
  expect(agents[0]!.name).not.toBe(agents[1]!.name);
});

test("the pane suffix escalates to the full pane id when workspaces collide", () => {
  // "w1:p1" and "w2:p1" both reduce to "p1", so the short suffix is not enough.
  const agents = toAgents(
    [
      raw({ name: null, pane_id: "w1:p1", workspace_id: "w1" }),
      raw({ name: null, pane_id: "w2:p1", workspace_id: "w2" }),
    ],
    ctx,
  );
  expect(agents.map((a) => a.name)).toEqual(["project w1:p1", "project w2:p1"]);
});

test("an unnamed agent is suffixed when a NAMED agent already holds the label", () => {
  // Distinguishability is about what is on screen, not about where the string
  // came from. The named agent keeps its name; the fallback moves aside.
  const agents = toAgents(
    [
      raw({ name: "project", pane_id: "w1:p9" }),
      raw({ name: null, pane_id: "w3:p1", workspace_id: "w3" }),
    ],
    ctx,
  );
  expect(agents.map((a) => a.name)).toEqual(["project", "project p1"]);
});

test("agents in DIFFERENT directories keep their plain basenames", () => {
  const agents = toAgents(
    [
      raw({ name: null, cwd: "/srv/project", pane_id: "w1:p1" }),
      raw({ name: null, cwd: "/srv/docs", pane_id: "w1:p2" }),
    ],
    ctx,
  );
  expect(agents.map((a) => a.name)).toEqual(["project", "docs"]);
});

test("a cwd with no usable basename falls back to the pane id", () => {
  for (const cwd of ["", "/", "///"]) {
    const [a] = toAgents([raw({ name: null, cwd, pane_id: "w3:p1" })], ctx);
    expect(a!.name).toBe("w3:p1");
  }
});

test("a trailing slash does not produce an empty basename", () => {
  const [a] = toAgents([raw({ name: null, cwd: "/srv/project/" })], ctx);
  expect(a!.name).toBe("project");
});

test("rows that are not agents are dropped before labelling", () => {
  const agents = toAgents([raw({ agent: null }), raw({ agent_status: "unknown" }), raw()], ctx);
  expect(agents).toHaveLength(1);
});

// --- hasJournal: injected predicate, session ids stay off the wire ---------

test("hasJournal is false when herdr sends no session", () => {
  const [a] = toAgents([raw({ pane_id: "w1:p1", name: "api-refactor" })], ctx);
  expect(a!.hasJournal).toBe(false);
});

test("hasJournal asks the injected predicate, never the harness name directly", () => {
  // Injected, because `adapter.ts` sits on the herdr axis and `journal/` sits
  // on the harness axis. A direct import would tie the two together and put
  // harness knowledge in the herdr adapter.
  const session = { agent: "claude", kind: "id", source: "herdr:claude", value: "u" };
  const [a] = toAgents([raw({ pane_id: "w1:p1", agent_session: session })], {
    ...ctx,
    hasJournal: (s) => s?.agent === "claude",
  });
  expect(a!.hasJournal).toBe(true);
});

test("sessionRefs keys by pane id and drops rows with no session", () => {
  const session = { agent: "claude", kind: "id", source: "herdr:claude", value: "u1" };
  const refs = sessionRefs([
    raw({ pane_id: "w1:p1", agent_session: session }),
    raw({ pane_id: "w1:p2" }),
  ]);
  expect(refs.get("w1:p1")).toEqual(session);
  expect(refs.has("w1:p2")).toBe(false);
});

test("the session id is NOT on the wire type", () => {
  // A session id is a filesystem key. The browser cannot need one, and paddock
  // does not hand filesystem keys to clients. Asserted on the serialized shape
  // because that is what actually crosses the socket.
  const session = { agent: "claude", kind: "id", source: "herdr:claude", value: "secret-uuid" };
  const [a] = toAgents([raw({ pane_id: "w1:p1", agent_session: session })], ctx);
  expect(JSON.stringify(a)).not.toContain("secret-uuid");
});
