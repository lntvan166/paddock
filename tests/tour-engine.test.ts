import { expect, test } from "bun:test";
import { createTour, type Tour } from "@site/tour/engine";
import { TOUR_STEPS, type TourStep } from "@site/tour/steps";
import { TOUR_ANCHORS } from "@shared/tour-anchors";

const steps: readonly TourStep[] = [
  { anchor: "needs-you", hash: "#/", title: "one", body: "b", advance: "click" },
  { anchor: "answer-options", hash: "#/pane/x", title: "two", body: "b", advance: "click" },
];

function tour() {
  const seen: number[] = [];
  let ended = false;
  const t: Tour = createTour({
    steps,
    onStep: (_s, i) => seen.push(i),
    onEnd: () => { ended = true; },
    hintAfterMs: 3000,
  });
  return { t, seen, ended: () => ended };
}

test("a step advances on the real action, not on being asked nicely", () => {
  const { t, seen } = tour();
  t.start();
  expect(seen).toEqual([0]);
  t.satisfy("answer-options");           // the wrong anchor
  expect(t.index(), "an unrelated click advanced the tour").toBe(0);
  t.satisfy("needs-you");
  expect(t.index()).toBe(1);
  expect(seen).toEqual([0, 1]);
});

test("the tour ends after the last step, once", () => {
  const { t, ended } = tour();
  t.start();
  t.satisfy("needs-you");
  t.satisfy("answer-options");
  expect(ended()).toBe(true);
  expect(t.current()).toBeNull();
});

test("show me appears only after the idle window, and only if nothing happened", () => {
  // A hint that appears instantly reads as an instruction to press it, which
  // makes the tour a slideshow again. One that never appears traps a visitor
  // hunting for a control they cannot find.
  const { t } = tour();
  t.start();
  t.tick(0);
  expect(t.hintVisible()).toBe(false);
  t.tick(2999);
  expect(t.hintVisible()).toBe(false);
  t.tick(3000);
  expect(t.hintVisible()).toBe(true);
});

test("the idle window restarts on each step", () => {
  const { t } = tour();
  t.start();
  t.tick(0);
  t.tick(3000);
  expect(t.hintVisible()).toBe(true);
  t.satisfy("needs-you");
  // A hint carried across a step boundary would appear immediately on step two,
  // before the visitor has had any chance to act.
  expect(t.hintVisible()).toBe(false);
});

test("show me satisfies the current step", () => {
  const { t } = tour();
  t.start();
  t.showMe();
  expect(t.index()).toBe(1);
});

test("skip ends the tour wherever it is", () => {
  const { t, ended } = tour();
  t.start();
  expect(ended()).toBe(false);
  t.skip();
  expect(ended()).toBe(true);
  // And a late event cannot resurrect it.
  t.satisfy("needs-you");
  expect(t.current()).toBeNull();
});

test("every real step names an anchor the app actually renders", () => {
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
