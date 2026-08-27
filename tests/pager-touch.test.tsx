import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { Pager } from "@web/components/Pager";
import { render, settle, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

/**
 * Touch wiring only.
 *
 * happy-dom has no layout, so `clientWidth` is 0 and any assertion about
 * DISTANCE would be meaningless here — the arithmetic is covered in
 * `tests/pager-gesture.test.ts` and the feel is verified in a browser. What is
 * worth asserting in this environment is the wiring: which handler runs, what
 * gets cancelled, and what reaches the callback.
 */

function fire(el: Element, type: string, x: number, y: number): Event {
  const t = { identifier: 1, target: el, clientX: x, clientY: y } as unknown as Touch;
  const ev = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === "touchend" || type === "touchcancel" ? [] : [t],
    changedTouches: [t],
  });
  el.dispatchEvent(ev);
  return ev;
}

test("a vertical drag is left to the browser", async () => {
  // The lists scroll. If the pager claims a vertical drag, scrolling breaks —
  // the worst possible trade for a feature nobody asked to replace it with.
  const calls: number[] = [];
  await render(<Pager index={0} onIndexChange={(i) => calls.push(i)} />);
  const track = document.querySelector(".pager-track")!;

  fire(track, "touchstart", 200, 400);
  const moved = fire(track, "touchmove", 202, 300);
  fire(track, "touchend", 202, 300);
  await settle();

  expect(moved.defaultPrevented, "the pager cancelled a vertical scroll").toBe(false);
  expect(calls).toEqual([]);
});

test("a horizontal drag is claimed", async () => {
  await render(<Pager index={0} onIndexChange={() => {}} />);
  const track = document.querySelector(".pager-track")!;

  fire(track, "touchstart", 300, 400);
  const moved = fire(track, "touchmove", 200, 402);
  await settle();

  expect(moved.defaultPrevented, "a horizontal drag was not claimed").toBe(true);
});

test("a tap is not a drag", async () => {
  // Rows are tappable. A gesture that never crosses the axis lock must leave
  // the tap alone, or every row press becomes a failed swipe.
  const calls: number[] = [];
  await render(<Pager index={1} onIndexChange={(i) => calls.push(i)} />);
  const track = document.querySelector(".pager-track")!;

  fire(track, "touchstart", 200, 400);
  const moved = fire(track, "touchmove", 202, 401);
  fire(track, "touchend", 202, 401);
  await settle();

  expect(moved.defaultPrevented, "a tap was treated as a drag").toBe(false);
  expect(calls).toEqual([]);
});

test("a cancelled touch settles the track instead of leaving it mid-drag", async () => {
  await render(<Pager index={1} onIndexChange={() => {}} />);
  const track = document.querySelector(".pager-track")! as HTMLElement;

  fire(track, "touchstart", 300, 400);
  fire(track, "touchmove", 200, 401);
  fire(track, "touchcancel", 200, 401);
  await settle();

  expect(track.classList.contains("is-settling"), "the track was left mid-drag").toBe(true);
  expect(track.style.transform).toContain("-100%");
});

test("a second finger abandons the gesture", async () => {
  // A pinch or a two-finger scroll is not a page turn. Continuing to track the
  // first finger through one would slide the page under a zoom.
  const calls: number[] = [];
  await render(<Pager index={0} onIndexChange={(i) => calls.push(i)} />);
  const track = document.querySelector(".pager-track")!;

  fire(track, "touchstart", 300, 400);
  const t1 = { identifier: 1, target: track, clientX: 200, clientY: 400 } as unknown as Touch;
  const t2 = { identifier: 2, target: track, clientX: 260, clientY: 400 } as unknown as Touch;
  track.dispatchEvent(new TouchEvent("touchmove", {
    bubbles: true, cancelable: true, touches: [t1, t2], changedTouches: [t1, t2],
  }));
  fire(track, "touchend", 200, 400);
  await settle();

  expect(calls).toEqual([]);
});

test("a committed drag reports the new index once", async () => {
  // The callback is what actually changes tab — `App` turns it into a
  // replaceState. Reporting twice would write history twice for one swipe.
  const calls: number[] = [];
  await render(<Pager index={0} onIndexChange={(i) => calls.push(i)} />);
  const track = document.querySelector(".pager-track")!;

  fire(track, "touchstart", 300, 400);
  fire(track, "touchmove", 200, 401);
  fire(track, "touchmove", 60, 402);
  fire(track, "touchend", 60, 402);
  await settle();

  // width is 0 in happy-dom, so any real drag counts as "far" — which is why
  // the distance rule itself is tested as arithmetic, not here.
  expect(calls).toEqual([1]);
});
