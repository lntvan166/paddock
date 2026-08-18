import { expect, test } from "bun:test";
import {
  DEFAULT_READ_LINES, HISTORY_LINES, historyTimeoutMs, readLinesFor,
} from "@server/herdr/actions";
import { HERDR_TIMEOUT_MS } from "@server/herdr/socket";

// Measured against herdr 0.8.0 on real agents: a `recent` read of 400 lines
// returns ~400 lines and takes 11-14 SECONDS, because herdr recovers
// alternate-screen history by physically scrolling the pane.

test("a history read is given a transport ceiling well past the default", () => {
  // The default is 10s. A history read measured at 11-14s would abort every
  // time under it — the feature cannot work without this.
  expect(historyTimeoutMs()).toBeGreaterThan(HERDR_TIMEOUT_MS);
  expect(historyTimeoutMs()).toBeGreaterThanOrEqual(20_000);
});

test("a live read keeps the default ceiling", () => {
  // `visible` answers in ~2ms. Giving it a 25s ceiling would turn a wedged
  // socket into a 25s hang on the one path that must stay instant.
  expect(readLinesFor(false)).toBe(DEFAULT_READ_LINES);
});

test("history asks for the measured sweet spot, not the caller's number", () => {
  // Asking herdr for MORE returns LESS: 2000 lines came back with 63, fewer
  // than the 400-line request, after ~16s. So the count is paddock's, not the
  // caller's — the same rule the read ceiling already follows.
  expect(readLinesFor(true)).toBe(HISTORY_LINES);
  expect(HISTORY_LINES).toBeGreaterThan(DEFAULT_READ_LINES);
  expect(HISTORY_LINES).toBeLessThan(2000);
});

test("a caller cannot widen or narrow a history read", () => {
  expect(readLinesFor(true, 2000)).toBe(HISTORY_LINES);
  expect(readLinesFor(true, 5)).toBe(HISTORY_LINES);
  expect(readLinesFor(true, undefined)).toBe(HISTORY_LINES);
});

test("a live read still honours a valid caller line count", () => {
  expect(readLinesFor(false, 40)).toBe(40);
  // and still clamps a hostile one
  expect(readLinesFor(false, 1e9)).toBeLessThanOrEqual(2000);
});
