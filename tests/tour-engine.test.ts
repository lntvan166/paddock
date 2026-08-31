import { expect, test } from "bun:test";
import { createTour, type Tour } from "@site/tour/engine";
import { TOUR_STEPS, type TourStep } from "@site/tour/steps";
import { TOUR_ANCHORS } from "@shared/tour-anchors";

/**
 * The tour walks; it does not hand over the controls.
 *
 * It used to advance on the REAL event — a tap inside the highlighted control —
 * with a "show me" escape after an idle window. That made every step a small
 * puzzle, and the visitor had to operate a demo they had not been shown yet to
 * see the next thing. It also meant the tour competed with the app underneath
 * for the same tap.
 *
 * So it highlights and the visitor presses Next. The demo stays live and
 * tappable whenever the tour is not running, which is where exploring belongs.
 */
const steps: readonly TourStep[] = [
  { anchor: "needs-you", hash: "#/", title: "one", body: "b" },
  { anchor: "answer-options", hash: "#/pane/x", title: "two", body: "b" },
];

function tour() {
  const seen: number[] = [];
  let ended = false;
  const t: Tour = createTour({
    steps,
    onStep: (_s, i) => seen.push(i),
    onEnd: () => { ended = true; },
  });
  return { t, seen, ended: () => ended };
}

test("it opens on the first step", () => {
  const { t, seen } = tour();
  t.start();
  expect(seen).toEqual([0]);
  expect(t.current()?.anchor).toBe("needs-you");
});

test("next walks forward one step at a time", () => {
  const { t, seen } = tour();
  t.start();
  t.next();
  expect(seen).toEqual([0, 1]);
  expect(t.current()?.anchor).toBe("answer-options");
});

test("the tour ends after the last step", () => {
  const { t, ended } = tour();
  t.start();
  t.next();
  t.next();
  expect(ended()).toBe(true);
  expect(t.current()).toBeNull();
});

test("skip ends it wherever it is", () => {
  const { t, ended } = tour();
  t.start();
  t.skip();
  expect(ended()).toBe(true);
  expect(t.current()).toBeNull();
});

test("nothing advances a tour that has already ended", () => {
  const { t, seen } = tour();
  t.start();
  t.skip();
  t.next();
  expect(seen).toEqual([0]);
  expect(t.current()).toBeNull();
});

test("every step names an anchor the app actually renders", () => {
  for (const s of TOUR_STEPS) {
    expect(TOUR_ANCHORS as readonly string[]).toContain(s.anchor);
  }
});

test("the real steps cover all six anchors, in reading order", () => {
  expect(TOUR_STEPS.map((s) => s.anchor)).toEqual([...TOUR_ANCHORS]);
});

test("the file step addresses an id the router accepts", () => {
  const file = TOUR_STEPS.find((s) => s.anchor === "file-frame")!;
  expect(file.hash).toMatch(/^#\/file\/[0-9a-f]{32}$/);
});

/**
 * The tour drives the demo, so the visitor watches it happen.
 *
 * Highlighting alone described controls without ever showing one work. A step
 * may now carry an ACT — the thing that control does — performed as the visitor
 * presses Next, so the story moves: the blocked agent is answered, the reply
 * lands in the transcript.
 *
 * Declared as a name rather than a function so this file stays data. The site
 * owns what each name does, because performing it needs the iframe.
 */
test("a step may declare what pressing Next demonstrates", () => {
  const answering = TOUR_STEPS.find((s) => s.anchor === "answer-options")!;
  expect(answering.act, "answering an agent demonstrates nothing").toBe("answer-option");
});

test("the reply step sends a real reply", () => {
  const replying = TOUR_STEPS.find((s) => s.anchor === "reply-field")!;
  expect(replying.act).toBe("send-reply");
  expect(replying.reply, "no text to send").toBeTruthy();
});

test("steps that only show something declare no act", () => {
  // Opening Spaces or the theme picker IS the demonstration; there is nothing
  // for a control to do beyond arriving there.
  for (const anchor of ["space-tree", "theme-picker"] as const) {
    expect(TOUR_STEPS.find((s) => s.anchor === anchor)!.act).toBeUndefined();
  }
});

test("every act named by a step is one the site knows how to perform", () => {
  // A name with no implementation is a Next that silently does nothing.
  const known = ["answer-option", "send-reply"];
  for (const s of TOUR_STEPS) {
    if (s.act !== undefined) expect(known).toContain(s.act);
  }
});
