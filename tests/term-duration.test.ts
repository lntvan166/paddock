import { expect, test } from "bun:test";
import { duration } from "@server/term";

// The complaint this exists to fix: a tunnel up for four days read "100h 30m".
test("days roll over instead of accumulating as hours", () => {
  expect(duration(361_800_000)).toBe("4d 4h");   // 100h 30m
  expect(duration(86_400_000)).toBe("1d 0h");
  expect(duration(604_800_000)).toBe("7d 0h");
});

// Carried over verbatim from human()'s five pinned values in
// tunnel-display.test.ts, which this function replaces.
test("the cases human() pinned still read the same", () => {
  expect(duration(0)).toBe("0s");
  expect(duration(42_000)).toBe("42s");
  expect(duration(372_000)).toBe("6m 12s");
  expect(duration(4_320_000)).toBe("1h 12m");
  expect(duration(-5_000)).toBe("0s");
});

// At most two units, largest first. A third unit would make the tunnel block
// — redrawn once a second — change width as it counts down.
test("at most two units, largest first", () => {
  expect(duration(361_845_000)).toBe("4d 4h");   // the 45s is not shown
  expect(duration(4_332_000)).toBe("1h 12m");    // the 12s is not shown
});

// The second unit is printed even at zero, for the same reason: a unit that
// vanishes at zero is a width change once an hour. human() already did this.
test("the second unit is printed at zero", () => {
  expect(duration(345_600_000)).toBe("4d 0h");
  expect(duration(3_600_000)).toBe("1h 0m");
  expect(duration(60_000)).toBe("1m 0s");
});

// A clock that has passed its deadline says 0s, never a negative.
test("negatives clamp to zero", () => {
  expect(duration(-1)).toBe("0s");
  expect(duration(-86_400_000)).toBe("0s");
});
