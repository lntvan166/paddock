/**
 * The pager's arithmetic, with no DOM in it.
 *
 * Every number here is a judgement about how a finger feels, which is exactly
 * the kind of thing that is wrong until it is tested. It lives apart from
 * `Pager.tsx` because the test environment is happy-dom: no layout, no touch
 * events, no `PointerEvent`. Embedded in the component this logic could not be
 * tested at all; extracted, it is ordinary functions over numbers.
 */

export type Axis = "x" | "y";

/** How far a finger travels before the gesture commits to an axis. Small
 *  enough not to feel sticky, large enough that a slightly slanted vertical
 *  scroll is not read as a sideways drag. */
export const AXIS_LOCK_PX = 8;

/** How much of a pull past the first or last tab actually shows. Resistance,
 *  not a wall: a wall reads as a broken gesture, movement says "nothing here". */
export const RUBBER = 0.32;

/** Fraction of the screen a slow drag must cross to change tab. */
export const COMMIT_FRACTION = 0.25;

/** px/ms above which a flick commits regardless of distance. */
export const FLICK_VELOCITY = 0.45;

/**
 * Which way this gesture is going, or `null` while it is too early to say.
 *
 * Ties go to `"y"`. The lists scroll and the pager does not, so a wrongly
 * claimed horizontal steals a scroll outright, while a wrongly claimed
 * vertical merely fails to page — the cheaper mistake of the two.
 */
export function axisOf(dx: number, dy: number, lock: number = AXIS_LOCK_PX): Axis | null {
  if (Math.abs(dx) < lock && Math.abs(dy) < lock) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/**
 * The drag distance actually applied to the track.
 *
 * Only the direction with no tab behind it resists. Dragging INTO the track
 * from an end is an ordinary move and must stay 1:1, or the first swipe of
 * every session feels wrong.
 */
export function damp(dx: number, atStart: boolean, atEnd: boolean): number {
  const pullingPastStart = atStart && dx > 0;
  const pullingPastEnd = atEnd && dx < 0;
  return pullingPastStart || pullingPastEnd ? dx * RUBBER : dx;
}

/**
 * Where the track lands when the finger lifts.
 *
 * Distance OR velocity commits: a slow deliberate drag past a quarter of the
 * screen, or a short confident flick. Requiring both would ignore the flick,
 * which is how a pager comes to feel unresponsive.
 *
 * Always at most one tab. A pager is not a fling list — moving two at once
 * loses the operator's place for no gain.
 */
export function nextIndex(
  { dx, velocity, width, index, count }:
  { dx: number; velocity: number; width: number; index: number; count: number },
): number {
  const far = Math.abs(dx) > width * COMMIT_FRACTION;
  const flick = Math.abs(velocity) > FLICK_VELOCITY;
  if (!far && !flick) return index;
  const step = dx < 0 ? 1 : -1;
  const next = index + step;
  if (next < 0 || next > count - 1) return index;
  return next;
}
