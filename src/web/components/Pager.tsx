import { useEffect, useRef, type TouchEvent } from "react";
import { axisOf, damp, nextIndex, type Axis } from "@web/components/pager-gesture";
import { Dashboard } from "@web/components/Dashboard";
import { Settings } from "@web/components/Settings";
import { Spaces } from "@web/components/Spaces";
import type { TabKey } from "@web/components/TabBar";

/** Tab order, left to right. `TabBar`'s own list must agree with this, and
 *  `tests/pager.test.tsx` fails if the two ever drift. */
export const PAGER_TABS = ["agents", "spaces", "settings"] as const satisfies readonly TabKey[];

/**
 * The three tab destinations, side by side in one track.
 *
 * WHY ALL THREE ARE MOUNTED. Finger-tracking needs the neighbouring screen
 * already on screen at the moment a drag begins — there is no time to mount
 * one mid-gesture. Three consequences, all wanted: each tab keeps its scroll
 * position; `useSpaceTree` never unmounts, so the "Spaces reloads every time"
 * report is deleted rather than cached around; and two tabs are alive while
 * off-screen, which is why the poll gates on `active` rather than on
 * `document.hidden` alone.
 *
 * The transform is in PERCENT, not pixels: percent needs no measurement, so
 * the track is correct on the first paint and after any resize without a
 * layout read. `Pager` owns no arithmetic — the feel lives in
 * `pager-gesture.ts` so it can be tested without a DOM.
 */
export function Pager({ index, onIndexChange }: {
  index: number;
  onIndexChange: (i: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  /** `index` for the handlers, which outlive the render that created them. */
  const indexRef = useRef(index);
  indexRef.current = index;
  /** The live non-passive touchmove listener, or null when nothing is being
   *  dragged. See the effect below for why it is not simply always attached. */
  const moveRef = useRef<((e: Event) => void) | null>(null);
  const drag = useRef<{
    x: number; y: number; axis: Axis | null; lastX: number; lastT: number; velocity: number;
  } | null>(null);

  /**
   * Move the track without React.
   *
   * A re-render per `touchmove` would drop frames, and the value is replaced
   * on the next frame anyway — this is the one place the DOM is written
   * directly, and it writes nothing React also owns. React still sets the
   * resting transform from `index`; this only ever adds the live offset.
   */
  const paint = (offsetPx: number, settling: boolean) => {
    const el = trackRef.current;
    if (el === null) return;
    el.classList.toggle("is-settling", settling);
    // `is-dragging` exists only to scope `will-change` to actual movement —
    // see the note on `.pager-track` in styles.css for the scrolling bug that
    // leaving it on permanently caused.
    el.classList.toggle("is-dragging", !settling && offsetPx !== 0);
    const at = -indexRef.current * 100;
    el.style.transform = offsetPx === 0
      ? `translate3d(${at}%, 0, 0)`
      : `translate3d(calc(${at}% + ${offsetPx}px), 0, 0)`;
  };

  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) { drag.current = null; detachMove(); return; }
    const t = e.touches[0]!;
    drag.current = {
      x: t.clientX, y: t.clientY, axis: null,
      lastX: t.clientX, lastT: Date.now(), velocity: 0,
    };
    const el = trackRef.current;
    if (el === null || moveRef.current !== null) return;
    const handler = (ev: Event) => { onTouchMoveRaw(ev as unknown as globalThis.TouchEvent); };
    moveRef.current = handler;
    el.addEventListener("touchmove", handler, { passive: false });
  };

  /**
   * Bound by hand, NOT as an `onTouchMove` prop — and only while a finger is
   * down.
   *
   * React registers touch handlers PASSIVELY, and `preventDefault()` inside a
   * passive listener does nothing: the browser logs "Unable to preventDefault
   * inside passive event listener invocation" and carries on, leaving the
   * pager unable to stop the browser's own interpretation of a drag. No unit
   * test could catch that — happy-dom honours `preventDefault` either way — so
   * it was found by reading the console after a real drag.
   *
   * WHY IT IS ATTACHED AND DETACHED RATHER THAN LEFT IN PLACE. A non-passive
   * `touchmove` listener forces the browser to run JS before it can decide
   * whether a gesture scrolls, so it cannot take its fast path. Reported from
   * a phone: opening the app and swiping straight to Settings left that screen
   * unable to scroll for a while before recovering. At launch the main thread
   * is mounting three screens, connecting a socket and fetching, so the
   * handler ran late and every scroll waited on it. Attached only for the life
   * of a gesture, an idle screen has no such listener and scrolls at full
   * native speed.
   *
   * The listener also used to be re-registered on EVERY render — no dependency
   * array — which during startup is many times a second.
   */
  const detachMove = () => {
    const el = trackRef.current;
    if (el !== null && moveRef.current !== null) {
      el.removeEventListener("touchmove", moveRef.current);
    }
    moveRef.current = null;
  };

  // Unmount is the one case no gesture handler will reach.
  useEffect(() => detachMove, []);

  const onTouchMoveRaw = (e: globalThis.TouchEvent) => {
    const d = drag.current;
    if (d === null) return;
    // A pinch or a two-finger scroll is not a page turn.
    if (e.touches.length !== 1) { drag.current = null; paint(0, true); return; }

    const t = e.touches[0]!;
    const dx = t.clientX - d.x;
    const dy = t.clientY - d.y;

    if (d.axis === null) {
      const decided = axisOf(dx, dy);
      if (decided === null) return;                        // too early to say
      if (decided === "y") { drag.current = null; return; }  // the list's, not ours
      d.axis = decided;
    }

    // Only once the gesture is definitely ours. Cancelling earlier would take
    // scrolls that were never ours to take.
    if (e.cancelable) e.preventDefault();

    // Position always; velocity only when the clock actually advanced.
    // These were one branch, which meant two moves inside the same
    // millisecond threw the position away — `Date.now()` has ms resolution,
    // so the release then measured a drag of zero and refused to commit.
    // Rare on a device at ~16ms per frame, wrong at any rate.
    const now = Date.now();
    if (now > d.lastT) {
      d.velocity = (t.clientX - d.lastX) / (now - d.lastT);
      d.lastT = now;
    }
    d.lastX = t.clientX;
    paint(damp(dx, indexRef.current === 0, indexRef.current === PAGER_TABS.length - 1), false);
  };

  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    // Detached FIRST, so an early return below cannot leave the listener in
    // place and the screen slow to scroll again.
    detachMove();
    if (d === null || d.axis !== "x") return;
    const next = nextIndex({
      dx: d.lastX - d.x,
      velocity: d.velocity,
      width: trackRef.current?.clientWidth ?? 0,
      index: indexRef.current,
      count: PAGER_TABS.length,
    });
    paint(0, true);
    if (next !== indexRef.current) onIndexChange(next);
  };

  const onTouchCancel = () => { drag.current = null; detachMove(); paint(0, true); };

  /** The settle is over, so the track is not moving and must not claim to be. */
  const onTransitionEnd = () => {
    trackRef.current?.classList.remove("is-settling", "is-dragging");
  };

  return (
    <div className="pager-viewport">
      <div
        ref={trackRef}
        className="pager-track"
        style={{ transform: `translate3d(${-index * 100}%, 0, 0)` }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        onTransitionEnd={onTransitionEnd}
      >
        {PAGER_TABS.map((tab, i) => (
          <div
            key={tab}
            className="pager-page"
            data-tab={tab}
            // Two of the three are off-screen but present. Unmarked, a screen
            // reader reads all three as one long page and the tab bar stops
            // meaning anything.
            aria-hidden={i === index ? undefined : true}
          >
            {tab === "agents" && <Dashboard active={i === index} />}
            {tab === "spaces" && <Spaces active={i === index} />}
            {tab === "settings" && <Settings />}
          </div>
        ))}
      </div>
    </div>
  );
}
