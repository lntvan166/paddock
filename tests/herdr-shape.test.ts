import { expect, test } from "bun:test";
import {
  checkAgentShape,
  REQUIRED_AGENT_FIELDS,
  shapeMessage,
  shapeSummary,
} from "@server/herdr/shape";

/** A raw `agent.list` entry with every field paddock requires. */
const raw = (over: Record<string, unknown> = {}) => ({
  pane_id: "w1:p1",
  workspace_id: "w1",
  agent_status: "working",
  name: "api-refactor",
  terminal_title_stripped: "Extract auth middleware",
  cwd: "/srv/project",
  revision: 3,
  ...over,
});

const without = (field: string) => {
  const a = raw() as Record<string, unknown>;
  delete a[field];
  return a;
};

test("the required set is exactly the fields whose absence is unambiguous", () => {
  // Optional fields are deliberately absent from this list. `name` and
  // `terminal_title_stripped` are `?:` in HerdrAgentRaw and the adapter falls
  // back for both, so a pane that simply has no assigned name legitimately
  // lacks them — their absence is never evidence the protocol dropped them.
  expect([...REQUIRED_AGENT_FIELDS].sort()).toEqual(["agent_status", "pane_id", "workspace_id"]);
});

test("a complete agent is ok", () => {
  expect(checkAgentShape([raw()])).toEqual({ kind: "ok" });
});

test("an empty list is unknown, never broken", () => {
  // You cannot conclude a field is gone from zero rows. Refusing to start
  // because herdr happens to have no panes open would be a self-inflicted
  // outage.
  expect(checkAgentShape([])).toEqual({ kind: "unknown" });
});

test("absent OPTIONAL fields are still ok", () => {
  // The false-positive guard, and the reason this check covers required fields
  // only: an unnamed pane is ordinary, not a protocol change.
  const bare = raw();
  delete (bare as Record<string, unknown>).name;
  delete (bare as Record<string, unknown>).terminal_title_stripped;
  expect(checkAgentShape([bare])).toEqual({ kind: "ok" });
});

test("each missing required field is named", () => {
  for (const field of ["pane_id", "workspace_id", "agent_status"]) {
    expect(checkAgentShape([without(field)])).toEqual({ kind: "broken", missing: [field] });
  }
});

test("several missing fields are all named, sorted and deduped", () => {
  const a = raw() as Record<string, unknown>;
  delete a.pane_id;
  delete a.agent_status;
  expect(checkAgentShape([a, { ...a }])).toEqual({
    kind: "broken",
    missing: ["agent_status", "pane_id"],
  });
});

test("every agent is checked, not just the first", () => {
  // A field can survive on one pane and vanish on another — herdr builds each
  // entry separately, so inspecting only element 0 would miss it.
  expect(checkAgentShape([raw(), raw(), without("agent_status")])).toEqual({
    kind: "broken",
    missing: ["agent_status"],
  });
});

test("a null required field counts as missing", () => {
  // `agent_status: null` renders every agent in one wrong state just as surely
  // as an absent key does, and it is the shape a renamed field leaves behind.
  expect(checkAgentShape([raw({ agent_status: null })])).toEqual({
    kind: "broken",
    missing: ["agent_status"],
  });
});

test("a non-object entry is broken rather than silently skipped", () => {
  expect(checkAgentShape([null]).kind).toBe("broken");
  expect(checkAgentShape(["nonsense"]).kind).toBe("broken");
});

test("the message names the fields and what to do, only when broken", () => {
  expect(shapeMessage({ kind: "ok" }, 20)).toBe(null);
  expect(shapeMessage({ kind: "unknown" }, 20)).toBe(null);

  const msg = shapeMessage({ kind: "broken", missing: ["agent_status"] }, 21);
  expect(msg).toContain("agent_status");
  expect(msg).toContain("21");
  // Actionable: regenerate the contract, then re-check the one file that maps it.
  expect(msg).toContain("make types");
  expect(msg).toContain("adapter.ts");
});

test("the health summary is a single line, or null", () => {
  // `/api/health` is JSON read by a phone; a multi-line console message would
  // render as one run-on blob in a banner. Same information, one line.
  expect(shapeSummary({ kind: "ok" })).toBe(null);
  expect(shapeSummary({ kind: "unknown" })).toBe(null);

  const line = shapeSummary({ kind: "broken", missing: ["agent_status", "pane_id"] });
  expect(line).not.toBeNull();
  expect(line).not.toContain("\n");
  expect(line).toContain("agent_status");
  expect(line).toContain("pane_id");
});
