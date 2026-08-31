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
  const at = main.indexOf("bringIntoView(el)");
  expect(at, "the anchor itself is never brought into view").toBeGreaterThan(-1);
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

test("the tour resets the demo before it starts", () => {
  // It answers the blocked agent and sends a reply, so a second run would open
  // on the wreckage of the first: nothing blocked, a transcript already replied
  // to, and step two pointing at options that are gone.
  expect(main, "a second run inherits the first one's state").toContain("location.reload()");
  expect(main, "the tour starts before the reload has landed").toMatch(/addEventListener\("load"/);
});

test("Next performs the step's act through the demo's own routes", () => {
  // Not by driving its DOM: the demo already simulates these, so asking it the
  // way the app asks it is less code and exercises the same path.
  expect(main).toContain("perform(step)");
  expect(main).toMatch(/api\/agents\//);
});

test("a step whose act fails still advances", () => {
  // A demo that would not answer must not strand the visitor on a Next that
  // does nothing.
  const fn = main.slice(main.indexOf("async function perform"));
  expect(fn.slice(0, fn.indexOf("\n}"))).toContain("catch");
});

test("the tour never scrolls the app sideways", () => {
  // `scrollIntoView` walks every scrollable ancestor, and one of them is the
  // pager's horizontal track: moving it fires the pager's own index change,
  // which rewrites the URL to whichever tab it landed on. Measured — a step
  // that navigated to `#/spaces` was dragged to `#/` a second later by the
  // tour's own scroll.
  // Scoped to the ANCHOR. The tour also scrolls the phone itself into view on
  // the host page before locking, which is a different element and correct.
  expect(main, "the anchor is still scrolled by every ancestor")
    .not.toContain("el.scrollIntoView");
  expect(main).toContain("bringIntoView");
});

/**
 * A way out of the phone, into the real thing.
 *
 * The embedded demo is 390px of a landing page, and on a narrow screen it is
 * 70vh of one — enough to watch, cramped to USE. `/app/` is the same build with
 * no page around it, which on a phone is indistinguishable from the installed
 * PWA. That is the strongest thing this site can show, and it was reachable
 * only by typing the path.
 *
 * A new tab, deliberately: the landing page keeps its place and its tour, and
 * the two run side by side rather than one replacing the other.
 */
test("the phone offers a way to open the demo full screen", () => {
  expect(main, "no way to leave the frame").toContain('href="/app/"');
  expect(main, "the landing page is replaced instead of joined").toContain('target="_blank"');
  expect(main).toContain("noopener");
});

test("the full-screen link is relative, like every other URL this file uses", () => {
  // Same rule as the hostname test above, and it is what makes the link work on
  // a preview deployment and on localhost as well as on the live site.
  const link = /<a[^>]*class="fullscreen"[^>]*>/.exec(main)?.[0] ?? "";
  expect(link, "the full-screen link is missing its class").not.toBe("");
  expect(link, "the full-screen link hardcodes a host").not.toContain("https://");
});
