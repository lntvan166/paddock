import { expect, test } from "bun:test";
import { formatElapsed } from "@web/components/elapsed";

test("under a minute reads as now", () => {
  expect(formatElapsed(0)).toBe("now");
  expect(formatElapsed(59_000)).toBe("now");
});

test("minutes", () => {
  expect(formatElapsed(60_000)).toBe("1m");
  expect(formatElapsed(14 * 60_000)).toBe("14m");
});

test("hours", () => {
  expect(formatElapsed(60 * 60_000)).toBe("1h");
  expect(formatElapsed(150 * 60_000)).toBe("2h");
});

test("days", () => {
  expect(formatElapsed(26 * 60 * 60_000)).toBe("1d");
});

test("negative clock skew does not produce a negative label", () => {
  expect(formatElapsed(-5000)).toBe("now");
});
