import type { TourStep } from "@site/tour/steps";

export type Tour = {
  start(): void;
  index(): number;
  current(): TourStep | null;
  /** The real event happened on this anchor. Ignored unless it is the one the
   *  current step is waiting for. */
  satisfy(anchor: string): void;
  hintVisible(): boolean;
  /** Monotonic milliseconds. Passed in rather than read, so the idle window is
   *  testable without waiting three seconds. */
  tick(nowMs: number): void;
  showMe(): void;
  skip(): void;
};

/**
 * Which step is current, and what moves it on.
 *
 * Steps advance on the REAL event — a tap inside the anchor, or the app having
 * navigated — never on a Next button. That is the difference between a tour and
 * a slideshow, and it also puts the visitor on a USED screen at every step,
 * which CLAUDE.md records as the state paddock's own controls have shipped
 * bugs in.
 *
 * Nothing here ever blocks. A hard gate is right inside an app somebody has
 * installed and wrong on a public page somebody is still evaluating, so `show
 * me` appears after an idle window and does the action for them.
 *
 * No DOM, no timers of its own: the caller owns both. This file is the part
 * worth testing, and it is testable without a browser.
 */
export function createTour(opts: {
  steps: readonly TourStep[];
  onStep: (step: TourStep, index: number) => void;
  onEnd: () => void;
  hintAfterMs?: number;
}): Tour {
  const hintAfterMs = opts.hintAfterMs ?? 3000;
  let i = -1;
  let done = false;
  let stepStartedAt: number | null = null;
  let hint = false;

  const enter = (next: number): void => {
    i = next;
    if (i >= opts.steps.length) {
      done = true;
      opts.onEnd();
      return;
    }
    // Reset both, or a hint earned on the previous step appears instantly on
    // this one — before the visitor has had any chance to act.
    stepStartedAt = null;
    hint = false;
    opts.onStep(opts.steps[i]!, i);
  };

  const advance = (): void => {
    if (done || i < 0) return;
    enter(i + 1);
  };

  return {
    start: () => { if (!done && i < 0) enter(0); },
    index: () => i,
    current: () => (done || i < 0 ? null : (opts.steps[i] ?? null)),
    satisfy: (anchor: string) => {
      if (done || i < 0) return;
      if (opts.steps[i]!.anchor !== anchor) return;
      advance();
    },
    hintVisible: () => hint,
    tick: (nowMs: number) => {
      if (done || i < 0) return;
      if (stepStartedAt === null) { stepStartedAt = nowMs; return; }
      if (nowMs - stepStartedAt >= hintAfterMs) hint = true;
    },
    showMe: advance,
    skip: () => {
      if (done) return;
      done = true;
      i = -1;
      opts.onEnd();
    },
  };
}
