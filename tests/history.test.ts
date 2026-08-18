import { expect, test } from "bun:test";
import { HISTORY_CAP, mergeSnapshot, type History } from "@web/history";

const empty = (): History => ({ settled: [], gaps: 0 });

test("the first snapshot settles nothing — it is all still on screen", () => {
  const h = mergeSnapshot(empty(), ["a", "b", "c"]);
  expect(h.settled).toEqual([]);
  expect(h.gaps).toBe(0);
});

test("an unchanged snapshot settles nothing", () => {
  let h = mergeSnapshot(empty(), ["a", "b", "c"]);
  h = mergeSnapshot(h, ["a", "b", "c"]);
  expect(h.settled).toEqual([]);
});

test("in-place tail churn settles nothing", () => {
  // The common case: a spinner or elapsed timer rewriting the bottom line.
  // Appending here is what would paste the timer into history dozens of times.
  let h = mergeSnapshot(empty(), ["a", "b", "working 1s"]);
  h = mergeSnapshot(h, ["a", "b", "working 2s"]);
  h = mergeSnapshot(h, ["a", "b", "working 3s"]);
  expect(h.settled).toEqual([]);
});

test("a scroll commits exactly the lines that left the viewport", () => {
  let h = mergeSnapshot(empty(), ["l1", "l2", "l3", "l4"]);
  // Scrolled up by two: l1 and l2 are gone for good.
  h = mergeSnapshot(h, ["l3", "l4", "l5", "l6"]);
  expect(h.settled).toEqual(["l1", "l2"]);
});

test("a scroll is detected even while the bottom is still churning", () => {
  // THE case that matters. The top is stable and the tail is being rewritten,
  // so an exact whole-snapshot match never happens — matching a window of
  // stable lines is what finds the scroll.
  let h = mergeSnapshot(empty(), ["l1", "l2", "l3", "l4", "l5", "working 1s"]);
  h = mergeSnapshot(h, ["l3", "l4", "l5", "l6", "l7", "working 9s"]);
  expect(h.settled).toEqual(["l1", "l2"]);
});

test("successive scrolls accumulate in order", () => {
  let h = mergeSnapshot(empty(), ["a", "b", "c", "d"]);
  h = mergeSnapshot(h, ["b", "c", "d", "e"]);
  h = mergeSnapshot(h, ["c", "d", "e", "f"]);
  expect(h.settled).toEqual(["a", "b"]);
});

test("an unreconcilable redraw records a gap instead of inventing history", () => {
  // A full repaint (the agent cleared the screen, or we missed several
  // scrolls between polls). Appending the old screen would duplicate;
  // appending the new one would lie about ordering. A counted gap is honest.
  let h = mergeSnapshot(empty(), ["a", "b", "c", "d"]);
  h = mergeSnapshot(h, ["totally", "different", "content", "here"]);
  expect(h.gaps).toBe(1);
});

test("history is capped, trimming the oldest first", () => {
  let h = empty();
  let prev = Array.from({ length: 4 }, (_, i) => `x${i}`);
  h = mergeSnapshot(h, prev);
  // Scroll one line at a time, well past the cap.
  for (let i = 4; i < HISTORY_CAP + 200; i++) {
    const next = [...prev.slice(1), `x${i}`];
    h = mergeSnapshot(h, next);
    prev = next;
  }
  expect(h.settled.length).toBeLessThanOrEqual(HISTORY_CAP);
  // The newest settled line is retained; the oldest is gone.
  expect(h.settled).not.toContain("x0");
  expect(h.settled[h.settled.length - 1]).toBe(`x${HISTORY_CAP + 200 - 5}`);
});

test("blank-heavy screens do not fake a scroll", () => {
  // A viewport padded with blank lines matches itself at many offsets. Taking
  // the SMALLEST offset keeps that from inventing a scroll that never
  // happened, which would duplicate real content into history.
  let h = mergeSnapshot(empty(), ["a", "", "", ""]);
  h = mergeSnapshot(h, ["a", "", "", ""]);
  expect(h.settled).toEqual([]);
});

test("an identical snapshot is a no-op, however many times it arrives", () => {
  // `apply` is reached from four call sites — the opening load, the poll, a
  // key press and a reply — so the same screen genuinely arrives repeatedly.
  // Each re-run of the offset search is another chance to commit twice.
  let h = mergeSnapshot(empty(), ["a", "b", "c", "d"]);
  h = mergeSnapshot(h, ["a", "b", "c", "d"]);
  const again = mergeSnapshot(h, ["a", "b", "c", "d"]);
  expect(again).toBe(h);
  expect(again.settled).toEqual([]);
});

test("settled history never contains a line still on the live screen", () => {
  // The seam invariant. `settled` renders directly above the live screen, so
  // a line in both is drawn twice — which is what a duplicate looks like to
  // the operator, and worse than missing history.
  let h = empty();
  let prev = ["l1", "l2", "l3", "l4", "l5", "l6"];
  h = mergeSnapshot(h, prev);
  for (let i = 7; i < 40; i++) {
    const next = [...prev.slice(1), `l${i}`];
    h = mergeSnapshot(h, next);
    prev = next;
  }
  const live = new Set(h.last!);
  expect(h.settled.filter((l) => live.has(l))).toEqual([]);
});
