import { expect, test } from "bun:test";
import { elapsedLabel, formatElapsed } from "@web/components/elapsed";

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
  // 2h30m rounds UP to "3h". This asserted "2h" while hours were floored, and
  // the direction is a deliberate choice rather than a side effect: an exact
  // half has to go somewhere, and for a label answering "has this been sitting
  // too long?" the safe error is looking older than you are. Overstating sends
  // an operator to check something sooner; understating leaves a stuck agent.
  expect(formatElapsed(150 * 60_000)).toBe("3h");
});

test("days", () => {
  expect(formatElapsed(26 * 60 * 60_000)).toBe("1d");
});

test("negative clock skew does not produce a negative label", () => {
  expect(formatElapsed(-5000)).toBe("now");
});


const H = 60 * 60_000;

test("an age most of the way through an hour rounds up, it does not floor away", () => {
  // Reported from a phone: agents idle for hours all read "1h". Half of that was
  // the flag below; this half was arithmetic. 1h51m floored to "1h", losing 51
  // minutes — and understating is the wrong direction for a label whose job is
  // "has this been sitting too long?".
  expect(formatElapsed(1.85 * H)).toBe("2h");
  expect(formatElapsed(89 * 60_000)).toBe("1h");
  expect(formatElapsed(90 * 60_000)).toBe("2h");
});

test("the hour-to-day boundary does not produce 24h", () => {
  // Rounding the hours could push 23h59m to "24h", which is a unit nobody
  // writes. The day branch has to be reached by the rounded value, not skipped
  // by the floored one.
  expect(formatElapsed(23.99 * H)).toBe("1d");
  expect(formatElapsed(23 * H)).toBe("23h");
});

test("an age paddock only bounds is marked, and an observed one is not", () => {
  // herdr's agent.list has no timestamp, so an agent paddock has just met has an
  // age it cannot know and `toAgent` stamps first sight. Rendering that as a
  // plain number was a lie the size of paddock's own uptime: five agents idle
  // for days all read "1h", sharing one stateSince to the millisecond.
  expect(elapsedLabel(2 * H, false)).toBe("2h+");
  expect(elapsedLabel(2 * H, true)).toBe("2h");
});

test("the mark is never added to `now`", () => {
  // Under a minute of watching says nothing either way, and "now+" reads as a
  // rendering fault rather than as a bound.
  expect(elapsedLabel(0, false)).toBe("now");
  expect(elapsedLabel(30_000, false)).toBe("now");
});
