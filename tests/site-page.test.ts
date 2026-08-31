import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { SECTIONS, sectionForScroll } from "@site/page";
import { TOUR_STEPS } from "@site/tour/steps";

test("every section pairs with a tour step, so the phone always has a screen", () => {
  expect(SECTIONS.map((s) => s.anchor)).toEqual(TOUR_STEPS.map((s) => s.anchor));
});

test("the most-visible section wins, not the first one intersecting", () => {
  // Two sections are on screen at once for most of a scroll. Picking the first
  // means the phone changes screen early and the copy beside it disagrees.
  expect(
    sectionForScroll([
      { anchor: "needs-you", ratio: 0.2 },
      { anchor: "answer-options", ratio: 0.8 },
    ]),
  ).toBe("answer-options");
});

test("nothing on screen drives nothing", () => {
  expect(sectionForScroll([])).toBeNull();
  expect(sectionForScroll([{ anchor: "needs-you", ratio: 0 }])).toBeNull();
});

const main = readFileSync("src/site/main.ts", "utf8");

test("the demo is embedded from /app/, the path the build assembles", () => {
  expect(main).toContain("/app/");
});

test("the site never imports a dashboard component", () => {
  // vite.site.config.ts has no React plugin and no @web alias, so this would
  // fail the build — but it would fail it confusingly, and the reason belongs
  // in a test that says it.
  const site = [
    "src/site/main.ts",
    "src/site/page.ts",
    "src/site/tour/steps.ts",
    "src/site/tour/engine.ts",
    "src/site/tour/spotlight.ts",
  ];
  for (const f of site) {
    expect(
      readFileSync(f, "utf8"),
      `${f} pulls the app bundle into the landing page`,
    ).not.toContain("@web/");
  }
});

test("scroll is locked while the tour runs", () => {
  // The hole is registered to the frame's on-screen position, so scrolling
  // behind the scrim desynchronises it from what it is pointing at.
  expect(main).toContain("overflow");
});

test("the page's script hardcodes no hostname of its own", () => {
  // One source for the site's own address. The hero and its install command are
  // static markup in site/index.html now, so THAT file carries the URL and
  // tests/site-meta.test.ts pins it to SITE_URL. This module must not grow a
  // second copy: two literals is what the github.io retirement cost to fix.
  expect(main, "main.ts hardcodes a hostname").not.toMatch(/https:\/\/[a-z0-9.-]*paddock/);
});

/**
 * Three defects that only appeared when the page was actually run, all of them
 * invisible to the unit tests above. They are asserted against the source
 * because reproducing them needs a real iframe, a real layout and real
 * scrolling — none of which happy-dom has.
 */
test("the tour never reaches into the demo to click for the visitor", () => {
  // It used to advance on the real event, with a "show me" that clicked the
  // highlighted control itself — which made every step a puzzle and let a stray
  // touch aimed at reading satisfy a step. The tour highlights and the visitor
  // presses Next; the demo stays tappable whenever the tour is NOT running,
  // which is where exploring belongs.
  expect(main, "the tour is clicking the demo's controls").not.toMatch(/el\.click\(\)/);
  expect(main, "a step still waits for a tap").not.toContain("tour.satisfy");
});

test("the anchor is scrolled into view before it is measured", () => {
  // An anchor below the phone's own fold has a rect nobody can see, and the
  // spotlight lands on a control that is genuinely not there yet. Both the
  // outer page and the phone scroll, so both are brought into view first.
  expect(main).toContain("scrollIntoView");
  const at = main.indexOf("scrollIntoView({ block: \"center\", inline: \"nearest\" })");
  expect(at, "the anchor itself is never scrolled into view").toBeGreaterThan(-1);
  // And measured only after that scroll has been applied — the same rule as
  // waiting for the repaint, one frame later.
  expect(main.indexOf("spotlightRect", at)).toBeGreaterThan(
    main.indexOf("requestAnimationFrame", at),
  );
});

test("a superseded step cannot move the spotlight", () => {
  // awaitAnchor resolves asynchronously, so a step already replaced by a fast
  // click or by Skip could still write its rect over the current step's. That
  // reads as a spotlight pointing at the wrong control, with nothing in the
  // console to explain it.
  expect(main).toContain("mine !== token");
});
