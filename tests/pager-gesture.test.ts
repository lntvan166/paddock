import { expect, test } from "bun:test";
import {
  AXIS_LOCK_PX, COMMIT_FRACTION, FLICK_VELOCITY, RUBBER,
  axisOf, damp, nextIndex,
} from "@web/components/pager-gesture";

/**
 * The pager's arithmetic, with no DOM anywhere near it.
 *
 * This module exists SO these can be tested. happy-dom has no layout and no
 * touch events, so the same logic living inside `Pager.tsx` would be
 * untestable — and it is the part most likely to be subtly wrong, because
 * every value in it is a judgement call about how a finger feels.
 */

test("no axis is claimed until the finger has travelled far enough", () => {
  // Claiming early makes a vertical scroll start by sliding the page
  // sideways. Below the threshold the answer is "not yet", not a guess.
  expect(axisOf(3, 2)).toBeNull();
  expect(axisOf(0, 0)).toBeNull();
  expect(axisOf(AXIS_LOCK_PX - 0.01, 0)).toBeNull();
});

test("past the threshold the larger movement wins", () => {
  expect(axisOf(20, 4)).toBe("x");
  expect(axisOf(4, 20)).toBe("y");
});

test("a diagonal drag resolves to the dominant axis, never to both", () => {
  // Equal movement must still pick one. Vertical is the safer default: the
  // lists scroll, and a mis-claimed horizontal steals a scroll outright.
  expect(axisOf(20, 20)).toBe("y");
});

test("the middle of the track follows the finger exactly", () => {
  // 1:1 is the whole feel. Any damping here reads as lag.
  expect(damp(-120, false, false)).toBe(-120);
  expect(damp(80, false, false)).toBe(80);
});

test("pulling past either end is resisted, so an end feels like an end", () => {
  expect(damp(200, true, false)).toBeCloseTo(200 * RUBBER);
  expect(damp(-200, false, true)).toBeCloseTo(-200 * RUBBER);
});

test("pulling INTO the track from an end is not resisted", () => {
  // At the first tab, dragging left goes to the second tab — a normal move.
  // Only the direction with nothing behind it rubber-bands.
  expect(damp(-200, true, false)).toBe(-200);
  expect(damp(200, false, true)).toBe(200);
});

test("a short slow drag snaps back rather than changing tab", () => {
  const width = 400;
  expect(nextIndex({ dx: -40, velocity: -0.05, width, index: 1, count: 3 })).toBe(1);
});

test("a long drag commits even with no speed", () => {
  const width = 400;
  const far = -(width * COMMIT_FRACTION) - 1;
  expect(nextIndex({ dx: far, velocity: 0, width, index: 0, count: 3 })).toBe(1);
});

test("a short flick commits on velocity alone", () => {
  // Without this, a fast confident flick that barely moves is ignored — the
  // single most common way a pager feels broken.
  const width = 400;
  expect(nextIndex({ dx: -20, velocity: -(FLICK_VELOCITY + 0.1), width, index: 0, count: 3 })).toBe(1);
});

test("direction is read from the drag, not the velocity's sign alone", () => {
  const width = 400;
  expect(nextIndex({ dx: 150, velocity: 0.8, width, index: 2, count: 3 })).toBe(1);
});

test("the ends refuse to move past themselves", () => {
  const width = 400;
  expect(nextIndex({ dx: 300, velocity: 2, width, index: 0, count: 3 })).toBe(0);
  expect(nextIndex({ dx: -300, velocity: -2, width, index: 2, count: 3 })).toBe(2);
});

test("a commit moves exactly one tab, however hard the flick", () => {
  // A pager is not a fling list. Two tabs at once loses the operator's place.
  const width = 400;
  expect(nextIndex({ dx: -3000, velocity: -12, width, index: 0, count: 3 })).toBe(1);
});
