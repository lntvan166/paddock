import { expect, test } from "bun:test";
import {
  checkAgentShape,
  REQUIRED_AGENT_FIELDS,
  shapeMessage,
  shapeSummary,
} from "@server/herdr/shape";
import { HERDR_AGENT_STATUSES } from "@shared/herdr-api";

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
    expect(checkAgentShape([without(field)])).toEqual({ kind: "broken", missing: [field], unknownStatuses: [] });
  }
});

test("several missing fields are all named, sorted and deduped", () => {
  const a = raw() as Record<string, unknown>;
  delete a.pane_id;
  delete a.agent_status;
  expect(checkAgentShape([a, { ...a }])).toEqual({
    kind: "broken",
    missing: ["agent_status", "pane_id"],
    unknownStatuses: [],
  });
});

// CORRECTED after review. This asserted that a field missing from ONE row of
// three was a broken contract, and that was the wrong rule: `toAgent` already
// drops rows it cannot map (a pane with no agent, an `agent_status` outside the
// four rendered states), so `agent.list` demonstrably carries rows paddock
// ignores. One anomalous row is per-row variation, and taking the whole
// dashboard down over it — `index.ts` calls `process.exit(1)` on `broken` — is a
// self-inflicted outage.
//
// A field is missing only when NO row carries it. With one row that is the same
// test as before; with many it is the only reading that distinguishes "herdr
// removed this" from "this pane is different".
test("a field present on SOME rows is not a contract change", () => {
  expect(checkAgentShape([raw(), raw(), without("agent_status")])).toEqual({ kind: "ok" });
});

test("a field absent from EVERY row is a contract change", () => {
  const gone = [without("agent_status"), without("agent_status")];
  expect(checkAgentShape(gone)).toEqual({
    kind: "broken",
    missing: ["agent_status"],
    unknownStatuses: [],
  });
});

test("one malformed row among healthy ones does not refuse", () => {
  // A single null element used to mark all three fields missing, so one bad
  // entry in a large response was a hard startup refusal.
  expect(checkAgentShape([raw(), null, raw()])).toEqual({ kind: "ok" });
});

// Finding 1, and the serious one. `checkProtocol` now accepts ANY newer herdr,
// and key-presence says nothing about the VALUE. `adapter.ts:toState` returns
// null for any status outside the four it renders, so `toAgent` drops the row
// entirely: a herdr that ADDS a status makes every agent in that state vanish
// from the dashboard with `schemaWarning: null` and nothing logged. Under the
// old `!==` gate that protocol would have refused to start loudly.
//
// The generated union IS the contract, so a value outside it is unambiguous
// evidence herdr widened the enum — the same standard as a required field going
// missing, and not something an operator can cause.
test("a status outside the generated enum is a contract change", () => {
  const widened = raw({ agent_status: "waiting" });
  expect(checkAgentShape([widened])).toEqual({
    kind: "broken",
    missing: [],
    unknownStatuses: ["waiting"],
  });
});

test("every status the generated enum knows is accepted", () => {
  // Including "unknown", which paddock deliberately does not render — dropping
  // a row is not the same as failing to understand the protocol.
  for (const status of HERDR_AGENT_STATUSES) {
    expect(checkAgentShape([raw({ agent_status: status })]).kind).toBe("ok");
  }
});

test("unknown statuses are deduped and sorted, and reported once", () => {
  const rows = [raw({ agent_status: "waiting" }), raw({ agent_status: "paused" }), raw({ agent_status: "waiting" })];
  expect(checkAgentShape(rows)).toEqual({
    kind: "broken",
    missing: [],
    unknownStatuses: ["paused", "waiting"],
  });
});

test("the message and the summary both name a widened enum", () => {
  const verdict = checkAgentShape([raw({ agent_status: "waiting" })]);
  expect(shapeMessage(verdict, 21)).toContain("waiting");
  expect(shapeSummary(verdict)).toContain("waiting");
});

test("a null required field counts as missing", () => {
  // `agent_status: null` renders every agent in one wrong state just as surely
  // as an absent key does, and it is the shape a renamed field leaves behind.
  expect(checkAgentShape([raw({ agent_status: null })])).toEqual({
    kind: "broken",
    missing: ["agent_status"],
    unknownStatuses: [],
  });
});

test("a non-object entry is broken rather than silently skipped", () => {
  expect(checkAgentShape([null]).kind).toBe("broken");
  expect(checkAgentShape(["nonsense"]).kind).toBe("broken");
});

test("the message names the fields and what to do, only when broken", () => {
  expect(shapeMessage({ kind: "ok" }, 20)).toBe(null);
  expect(shapeMessage({ kind: "unknown" }, 20)).toBe(null);

  const msg = shapeMessage({ kind: "broken", missing: ["agent_status"], unknownStatuses: [] }, 21);
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

  const line = shapeSummary({ kind: "broken", missing: ["agent_status", "pane_id"], unknownStatuses: [] });
  expect(line).not.toBeNull();
  expect(line).not.toContain("\n");
  expect(line).toContain("agent_status");
  expect(line).toContain("pane_id");
});
