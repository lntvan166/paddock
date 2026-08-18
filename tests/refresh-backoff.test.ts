import { expect, test } from "bun:test";
import { MAX_REFRESH_MS, MIN_REFRESH_MS, nextRefreshMs } from "@web/components/AgentTerminal";

test("a changed screen snaps back to the floor from anywhere on the ladder", () => {
  for (const from of [MIN_REFRESH_MS, 2_250, 7_594, MAX_REFRESH_MS]) {
    expect(nextRefreshMs(from, true)).toBe(MIN_REFRESH_MS);
  }
});

test("unchanged screens back off, and stop at the ceiling", () => {
  const ladder: number[] = [];
  let cur = MIN_REFRESH_MS;
  for (let i = 0; i < 10; i++) { cur = nextRefreshMs(cur, false); ladder.push(cur); }
  // Strictly increasing until the cap, never past it.
  expect(ladder[0]).toBe(1_500);
  expect(Math.max(...ladder)).toBe(MAX_REFRESH_MS);
  for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeGreaterThanOrEqual(ladder[i - 1]!);
  expect(ladder.at(-1)).toBe(MAX_REFRESH_MS);
});

test("the ceiling is a fixed point, not a value it can exceed", () => {
  expect(nextRefreshMs(MAX_REFRESH_MS, false)).toBe(MAX_REFRESH_MS);
  expect(nextRefreshMs(MAX_REFRESH_MS * 5, false)).toBe(MAX_REFRESH_MS);
});

test("reaching the ceiling takes a handful of quiet polls, not dozens", () => {
  // Pins the shape of the curve: a pane that goes quiet should stop costing
  // requests quickly, but not so abruptly that a brief pause makes it sluggish.
  // Bounded, not `while (cur < MAX)`. An unbounded loop here does not FAIL if
  // the backoff factor is ever set to 1.0 — it HANGS, which is strictly worse
  // than a red test: it stalls the suite with no diagnosis. Found by mutating
  // REFRESH_BACKOFF to 1.0 and watching this file spin instead of report.
  let cur = MIN_REFRESH_MS, steps = 0;
  const LIMIT = 100;
  while (cur < MAX_REFRESH_MS && steps < LIMIT) { cur = nextRefreshMs(cur, false); steps++; }
  expect(steps).toBeLessThan(LIMIT);
  expect(cur).toBe(MAX_REFRESH_MS);
  expect(steps).toBeGreaterThanOrEqual(4);
  expect(steps).toBeLessThanOrEqual(8);
});
