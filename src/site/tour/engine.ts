import type { TourStep } from "@site/tour/steps";

export type Tour = {
  start(): void;
  index(): number;
  current(): TourStep | null;
  /** Move to the next step, or end the tour if this was the last. */
  next(): void;
  skip(): void;
};

/**
 * Which step is current, and nothing else.
 *
 * The tour WALKS; it does not hand over the controls. An earlier version
 * advanced on the real event — a tap inside the highlighted control — with a
 * "show me" escape after an idle window. Two things were wrong with it. It made
 * every step a small puzzle, asking the visitor to operate a demo they had not
 * been shown yet in order to see the next thing. And the tour's scrim competed
 * with the live app underneath for the same tap, so a step could be satisfied
 * by a stray touch that was aimed at reading, not answering.
 *
 * Highlight, explain, Next. The demo stays live and tappable whenever the tour
 * is NOT running, which is where exploring belongs.
 *
 * No DOM and no timers: the caller owns both, which is what keeps this file
 * testable without a browser.
 */
export function createTour(opts: {
  steps: readonly TourStep[];
  onStep: (step: TourStep, index: number) => void;
  onEnd: () => void;
}): Tour {
  let i = -1;
  let done = false;

  const enter = (at: number): void => {
    i = at;
    if (i >= opts.steps.length) {
      done = true;
      opts.onEnd();
      return;
    }
    opts.onStep(opts.steps[i]!, i);
  };

  return {
    start: () => { if (!done && i < 0) enter(0); },
    index: () => i,
    current: () => (done || i < 0 ? null : (opts.steps[i] ?? null)),
    next: () => { if (!done && i >= 0) enter(i + 1); },
    skip: () => {
      if (done) return;
      done = true;
      i = -1;
      opts.onEnd();
    },
  };
}
