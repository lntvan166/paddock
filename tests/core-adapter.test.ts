import { expect, spyOn, test } from "bun:test";
import { applyCoreEvent, toCoreAgent } from "@server/herdr-core/adapter";
import type { CoreEvent, CoreTerminal } from "@shared/herdr-core-api";
import fixtures from "./fixtures/core-terminals.json";

const f = fixtures as unknown as Record<string, CoreTerminal>;
const term = (key: string, patch: Partial<CoreTerminal> = {}): CoreTerminal => ({ ...f[key]!, ...patch });

test("a reporting live terminal becomes a core agent with exact stateSince", () => {
  const a = toCoreAgent(f.reporting!, "dev-box")!;
  expect(a.agentId).toBe("hc.t7");
  expect(a.hostId).toBe("dev-box");
  expect(a.name).toBe("api-refactor");
  expect(a.task).toBe("editing handlers");
  expect(a.state).toBe("working");
  expect(a.harness).toBe("claude");
  expect(a.stateSince).toBe(1700000005000);
  expect(a.stateSinceExact).toBe(true);
  expect(a.workspaceId).toBe("hc.sp1");
  expect(a.workspaceLabel).toBe("api-space");
  expect(a.turn).toBe(3);
  expect(a.seen).toBeNull();
  expect(a.origin).toBe("core");
  expect(a.hasJournal).toBe(false);
  expect(a.acknowledgedAt).toBeNull();
});

test("a terminal that never reported is not an agent", () => {
  expect(toCoreAgent(f.shell!, "h")).toBeNull();
  expect(toCoreAgent(f.finished!, "h")).toBeNull();
});

test("a pane-less sub-agent is left out", () => {
  expect(toCoreAgent(f.subAgent!, "h")).toBeNull();
  // with a tab label it has a pane, so it stays
  const withTab = term("subAgent", { labels: { "herdr.space": "sp1", "herdr.tab": "t" } });
  expect(toCoreAgent(withTab, "h")).not.toBeNull();
});

test("name falls back to the address, never the folder", () => {
  expect(toCoreAgent(f.unnamed!, "h")!.name).toBe("t10");
});

test("blocked with kind permission maps to blocked", () => {
  const t = term("reporting", { status: { app: "claude-code", state: "blocked", kind: "permission", msg: "approve Bash: touch x" } });
  const a = toCoreAgent(t, "h")!;
  expect(a.state).toBe("blocked");
  expect(a.task).toBe("approve Bash: touch x");
});

test("error maps to error", () => {
  expect(toCoreAgent(term("reporting", { status: { state: "error", app: "claude-code" } }), "h")!.state).toBe("error");
});

test("herdr.seen label becomes seen", () => {
  const t = term("reporting", { labels: { "herdr.space": "sp1", "herdr.seen": "2" } });
  expect(toCoreAgent(t, "h")!.seen).toBe(2);
});

test("a finished event removes the agent", () => {
  const prev = toCoreAgent(f.reporting!, "h")!;
  const e: CoreEvent = { seq: 5, type: "finished", terminal: "t7", data: { reason: "exited", exit_code: 0, signal: null, finished_ms: 1 } };
  expect(applyCoreEvent(prev, e)).toBeNull();
});

test("an unknown status word is idle and logged once", () => {
  const spy = spyOn(console, "info").mockImplementation(() => {});
  try {
    const t = term("reporting", { status: { state: "daydreaming-xyz", app: "claude-code" } });
    expect(toCoreAgent(t, "h")!.state).toBe("idle");
    expect(toCoreAgent(t, "h")!.state).toBe("idle");
    const logged = spy.mock.calls.filter((c) => String(c[0]).includes("daydreaming-xyz"));
    expect(logged.length).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

test("status event moves state, stamps stateSince, and clears acknowledgement off done", () => {
  const prev = { ...toCoreAgent(f.reporting!, "h")!, state: "done" as const, acknowledgedAt: 99 };
  const e: CoreEvent = { seq: 6, type: "status", terminal: "t7", data: { status: { app: "claude-code", state: "working", msg: "next" }, records: {}, reported: true } };
  const a = applyCoreEvent(prev, e, undefined, { now: 5000 })!;
  expect(a.state).toBe("working");
  expect(a.stateSince).toBe(5000);
  expect(a.task).toBe("next");
  expect(a.acknowledgedAt).toBeNull();
  const same = applyCoreEvent(a, e, undefined, { now: 9000 })!;
  expect(same.stateSince).toBe(5000);
});

test("a status event that clears the status removes the agent", () => {
  const prev = toCoreAgent(f.reporting!, "h")!;
  const e: CoreEvent = { seq: 6, type: "status", terminal: "t7", data: { status: null, records: {}, reported: true } };
  expect(applyCoreEvent(prev, e)).toBeNull();
});

test("turn and labels events update the counter, seen and workspace", () => {
  const prev = toCoreAgent(f.reporting!, "h")!;
  const t = applyCoreEvent(prev, { seq: 7, type: "turn", terminal: "t7", data: { turn: 4, state: "idle" } })!;
  expect(t.turn).toBe(4);
  const l = applyCoreEvent(t, { seq: 8, type: "labels", terminal: "t7", data: { labels: { "herdr.space": "sp2", "herdr.seen": "4" } } })!;
  expect(l.seen).toBe(4);
  expect(l.workspaceId).toBe("hc.sp2");
  const cleared = applyCoreEvent(l, { seq: 9, type: "labels", terminal: "t7", data: { labels: { "herdr.space": "sp2" } } })!;
  expect(cleared.seen).toBeNull();
});

test("created, labels-with-record and removed events", () => {
  const created = applyCoreEvent(null, { seq: 1, type: "created", terminal: "t7", data: f.reporting! }, undefined, { hostId: "dev-box" })!;
  expect(created.agentId).toBe("hc.t7");
  expect(created.hostId).toBe("dev-box");
  const viaLabels = applyCoreEvent(null, { seq: 2, type: "labels", terminal: "t7", data: { labels: f.reporting!.labels, record: f.reporting! } }, undefined, { hostId: "dev-box" });
  expect(viaLabels?.agentId).toBe("hc.t7");
  expect(applyCoreEvent(created, { seq: 3, type: "removed", terminal: "t7", data: {} })).toBeNull();
});

test("an unknown event type leaves the agent untouched", () => {
  const prev = toCoreAgent(f.reporting!, "h")!;
  expect(applyCoreEvent(prev, { seq: 4, type: "newthing", terminal: "t7", data: {} } as any)).toBe(prev);
});
