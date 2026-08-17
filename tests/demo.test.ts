import { expect, test } from "bun:test";
import { DEMO_HOST_ID, DemoSource, demoAgents } from "@server/demo";
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
