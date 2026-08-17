import { expect, test } from "bun:test";
import { createDemoSource, DEMO_HOST_ID, DemoSource, demoAgents } from "@server/demo";
import { AgentStore } from "@server/state/store";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

// Asserted as an ALLOWLIST, not a denylist of real names. Listing real names here
// to check they are absent would commit them to a public repo — the guard would
// leak exactly what it guards.
const INVENTED_NAMES = new Set([
  "schema-migration", "lint-config", "api-refactor",
  "perf-audit", "docs-cleanup", "flaky-test-fix",
]);

test("demo data covers every displayed state", () => {
  const states = new Set(demoAgents(NOW).map((a) => a.state));
  expect(states).toEqual(new Set(["blocked", "done", "working", "idle"]));
});

test("every demo name comes from the invented fixture set", () => {
  for (const a of demoAgents(NOW)) {
    expect(INVENTED_NAMES.has(a.name)).toBe(true);
  }
});

test("demo cwd is not a real home directory", () => {
  for (const a of demoAgents(NOW)) {
    expect(a.cwd.startsWith("/" + "home/")).toBe(false);
    expect(a.cwd.startsWith("/" + "Users/")).toBe(false);
  }
});

test("demo agents all belong to the demo host", () => {
  for (const a of demoAgents(NOW)) expect(a.hostId).toBe(DEMO_HOST_ID);
});

test("tick emits a delta", () => {
  const seen: Agent[][] = [];
  const src = new DemoSource({ onDelta: (d) => seen.push(d.upserted), now: () => NOW });
  src.tick();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.length).toBeGreaterThan(0);
});

test("snapshot is stable across ticks in size", () => {
  const src = new DemoSource({ onDelta: () => {}, now: () => NOW });
  const before = src.snapshot().length;
  src.tick();
  expect(src.snapshot()).toHaveLength(before);
});

test("a demo tick is reflected in the STORE, not just pushed at browsers", () => {
  // Demo mode used to wire DemoSource.onDelta straight to the hub, so the
  // store was seeded once and never updated again: /api/agents returned
  // startup state forever, and a browser loading the page later got a stale
  // snapshot patched only as the 4s cursor happened to revisit each agent.
  const store = new AgentStore(DEMO_HOST_ID);
  let ticks = 0;
  const src = createDemoSource({ store, onDelta: () => { ticks++; }, now: () => NOW });
  store.replaceAll(src.snapshot(), NOW);

  const changed = src.snapshot()[0]!;
  const before = store.snapshot().find((a) => a.agentId === changed.agentId)!;

  src.tick();

  const after = store.snapshot().find((a) => a.agentId === changed.agentId)!;
  const ticked = src.snapshot().find((a) => a.agentId === changed.agentId)!;
  expect(ticks).toBe(1);
  expect(after.state).toBe(ticked.state);
  expect(after.state).not.toBe(before.state);
});

test("the delta browsers receive in demo mode is the store's own", () => {
  const store = new AgentStore(DEMO_HOST_ID);
  const deltas: { upserted: Agent[]; removedIds: string[] }[] = [];
  const src = createDemoSource({ store, onDelta: (d) => deltas.push(d), now: () => NOW });
  store.replaceAll(src.snapshot(), NOW);

  src.tick();

  expect(deltas).toHaveLength(1);
  for (const a of deltas[0]!.upserted) {
    // Every agent a browser is told about must be findable in the store, or
    // the two would disagree the moment the browser reconnected.
    expect(store.snapshot()).toContainEqual(a);
  }
  expect(deltas[0]!.upserted.length).toBeGreaterThan(0);
});
