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

/**
 * The phone does not CLIP the demo, it just sits behind it.
 *
 * Third round on the same white rectangle, and this is the construct the
 * evidence actually points at. Measured by elimination, not guessed:
 *
 *   - `/app/` opens normally in Safari, so the app and its bundle are fine.
 *   - `/app/?embed=1` opens normally in Safari, so the embed-only CSS is fine.
 *   - Only the demo INSIDE the phone is white, so it is the wrapper.
 *   - It was white at phone width too, where `.phone-rail` is `position:
 *     static`, so it is not the sticky rail.
 *
 * That leaves `overflow: hidden` plus `border-radius` on the iframe's parent —
 * Safari has to build a rounded mask for a composited child, and when it fails
 * the layer paints as blank white. The iframe is exactly the content box, so
 * nothing was ever overflowing: the clip existed only to round the corners.
 *
 * The radius moves onto the iframe itself. If Safari declines to round an
 * iframe the corners are square inside a rounded bezel — cosmetic, and a
 * failure you can look at, instead of a white rectangle where the product is.
 */
const siteCss = readFileSync("src/site/styles.css", "utf8");

function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

test("the phone does not clip the iframe", () => {
  expect(rule(siteCss, ".phone"), "the phone still clips a composited iframe").not.toContain(
    "overflow: hidden",
  );
});

test("the screen's corners are rounded on the iframe itself", () => {
  // Otherwise dropping the clip just squares them off everywhere, not only in
  // the engine that could not handle the mask.
  expect(rule(siteCss, ".demo")).toContain("border-radius");
});

/**
 * Nothing is written into the frame until it has LOADED. This is the white
 * phone, finally — reproduced in WebKit 26.5 rather than reasoned about.
 *
 *   webkit    url=about:blank#/          rootKids=NO ROOT
 *   chromium  url=/app/?embed=1          rootKids=1
 *
 * The phone follows the copy by setting `contentWindow.location.hash`, and the
 * IntersectionObserver delivers its first callback immediately — before the
 * iframe has finished loading its `src`. Writing a hash then is a same-document
 * navigation on the INITIAL blank document, and WebKit lets it win: the pending
 * load of `/app/?embed=1` is cancelled and the frame sits on `about:blank#/`
 * for good. Chromium lets the src load win, which is why every measurement
 * taken here for three rounds looked perfect.
 *
 * It was never a paint bug, a compositing bug or a CSS bug. `#root` was missing
 * from the frame's document, and `#root` is static markup — no JavaScript has
 * to run for it to exist. That single fact ruled out everything else at once.
 */
test("the frame is not driven before it has loaded", () => {
  expect(main, "no readiness flag — writes can land on about:blank").toContain("frameReady");
  expect(main, "the early write is not turned away").toMatch(/if \(!frameReady\)/);
});

test("there is exactly one place that writes the frame's location", () => {
  // Two would mean one of them is ungated, and the ungated one is the bug.
  const writes = main.match(/location\.hash\s*=/g) ?? [];
  expect(writes.length, `${writes.length} places write the frame's hash`).toBe(1);
});

test("a hash asked for too early is not lost, it is applied on load", () => {
  // Dropping it would leave the phone on whatever route `src` names while the
  // copy beside it has already scrolled somewhere else.
  expect(main).toContain("pendingHash");
});

/**
 * And the phone is not squeezed by the link beneath it.
 *
 * `.phone-rail` became a column to seat the full-screen link, which made the
 * phone a flex item that shrinks: measured 390x396 in a short window, against
 * the 780 it asks for. Flex items shrink below their own height by default.
 */
test("the phone does not shrink to fit its rail", () => {
  expect(rule(siteCss, ".phone")).toContain("flex-shrink: 0");
});

/**
 * While the tour runs, the tour has the controls.
 *
 * Measured in WebKit with the tour on screen: `document.elementFromPoint` at
 * the centre of the spotlight returned `IFRAME.demo`. Nothing blocked. The
 * scrim is the hole's own spread shadow and a box-shadow is not hit-testable,
 * and the hole itself is `pointer-events: none` — so every part of the page,
 * lit or dimmed, stayed live under the overlay.
 *
 * That `pointer-events: none` is a leftover. It was correct when a tap on the
 * highlighted control was what advanced the step; the tour walks by Next now,
 * and a visitor who taps the demo mid-tour navigates it out from under the
 * step that is describing it — the walkthrough stops walking, without anything
 * having failed.
 *
 * A transparent blocker beneath the hole and above the page. The hole keeps
 * `pointer-events: none` so the blocker takes the click even inside the lit
 * rectangle; the callout sits above both, so Skip and Next still work. Those
 * two are the only controls during a tour, which is the whole point of one.
 */
const overlayCss = readFileSync("src/site/tour/overlay.css", "utf8");

test("the tour puts a blocker over the page", () => {
  const block = rule(overlayCss, ".tour-block");
  expect(block).toMatch(/position:\s*fixed/);
  expect(block).toMatch(/inset:\s*0/);
  expect(main, "the blocker is never added to the page").toContain("tour-block");
});

test("the blocker sits under the hole and the callout, and over everything else", () => {
  const z = (sel: string) => Number(/z-index:\s*(\d+)/.exec(rule(overlayCss, sel))?.[1] ?? NaN);
  expect(z(".tour-block")).toBeLessThan(z(".tour-hole"));
  expect(z(".tour-block")).toBeLessThan(z(".tour-callout"));
});

test("the blocker actually takes pointer events", () => {
  // The failure it exists to prevent is a full-screen element that is see-
  // through to clicks as well as to light, which is what the hole already is.
  expect(rule(overlayCss, ".tour-block")).not.toMatch(/pointer-events:\s*none/);
});

test("the blocker is removed when the tour ends", () => {
  // Left behind, it is an invisible sheet over a page nobody can click again.
  const end = main.slice(main.indexOf("hole.remove()"));
  expect(end.slice(0, 200)).toContain("block.remove()");
});

/**
 * And a tour always opens where step 01 says it does.
 *
 * The demo stays live between tours, so a visitor who explored and left it on
 * Spaces got a second tour whose first step described the agent list while the
 * phone showed something else. `reload()` alone does not fix that: it keeps the
 * whole URL, fragment included.
 */
test("starting a tour returns the demo to the dashboard first", () => {
  const start = main.slice(main.indexOf('.tour-start")!.addEventListener'));
  const reloadAt = start.indexOf("location.reload()");
  const homeAt = start.indexOf('goto("#/")');
  expect(homeAt, "nothing sends the demo home before a tour").toBeGreaterThan(-1);
  expect(homeAt, "it goes home AFTER the reload, which reloads the old route")
    .toBeLessThan(reloadAt);
});

/**
 * The page recedes; the phone does not.
 *
 * The first overlay dimmed everything and cut ONE hole, the size of the
 * highlighted control — so the phone spent the whole tour under an 86%-opaque
 * black sheet with a small window in it. The demo is the thing the tour is
 * about, and it was the least visible thing on screen.
 *
 * The copy around it is what should recede, and it recedes by being BLURRED
 * rather than blacked out: the reader can still see a page is there and where
 * they are in it. The phone keeps its own colours at full strength, the
 * spotlight still marks the control under discussion, and `.tour-block` still
 * means nothing in either half is clickable.
 */
test("the tour blurs the page around the phone", () => {
  const dim = rule(overlayCss, ".tour-on .hero,\n.tour-on .copy");
  expect(dim).toMatch(/filter:\s*blur\(/);
});

test("the phone itself is never blurred or dimmed", () => {
  // The whole point. A selector reaching the rail would put the demo behind
  // exactly the sheet this replaces.
  const on = overlayCss.slice(overlayCss.indexOf(".tour-on"));
  const blurRules = on.split("}").filter((r) => /filter:\s*blur\(/.test(r));
  expect(blurRules.length).toBeGreaterThan(0);
  for (const r of blurRules) {
    expect(r, "a blur rule reaches the phone").not.toContain("phone");
    expect(r, "a blur rule reaches the demo iframe").not.toContain(".demo");
  }
});

test("the hole no longer paints a full-screen scrim", () => {
  // It was `box-shadow: 0 0 0 9999px` — the sheet itself. The outline that
  // marks the control stays; that is the highlight.
  const hole = rule(overlayCss, ".tour-hole");
  expect(hole, "the hole still spreads a scrim over everything").not.toMatch(/9999px/);
  expect(hole, "the spotlight lost its outline").toMatch(/outline:/);
});

test("the blur is applied and removed with the tour", () => {
  expect(main).toContain("tour-on");
  const end = main.slice(main.indexOf("block.remove()"));
  expect(end.slice(0, 300), "the page stays blurred after the tour").toContain("tour-on");
});

/**
 * The spotlight arrives with the screen, not after it.
 *
 * Reported: "the screen and animation not match, screen change first then
 * animation of highlight show slower." Both halves of that are in the
 * sequencing. `goto(step.hash)` runs synchronously when a step opens, so the
 * phone repaints at once — but the hole cannot be positioned until the new
 * screen's anchor exists, which is an `awaitAnchor` and two animation frames
 * later. And the hole then TRAVELLED there, over a 180ms transition on left,
 * top, width and height.
 *
 * So the outline spent that time sliding across a screen it no longer
 * described, from a control that was no longer on it.
 *
 * Nothing travels now. The marks — hole, connector and callout — are hidden
 * while a step resolves and fade in together once the hole has been measured
 * and the connector drawn. A cut in the right place reads as instant; a slide
 * into the right place reads as late, which is exactly what was reported.
 */
test("the spotlight does not travel between steps", () => {
  const hole = rule(overlayCss, ".tour-hole");
  expect(hole, "the hole still animates its position").not.toMatch(
    /transition:[^;]*\b(left|top|width|height)\b/,
  );
});

test("the marks are invisible until they are in place", () => {
  for (const sel of [".tour-hole", ".tour-line", ".tour-callout"]) {
    expect(rule(overlayCss, sel), `${sel} is visible before it is positioned`).toMatch(
      /opacity:\s*0\b/,
    );
  }
  expect(overlayCss, "nothing ever reveals the marks").toContain("is-placed");
});

test("a step hides the marks before it moves them, and reveals them after", () => {
  const step = main.slice(main.indexOf("onStep:"), main.indexOf("onEnd:"));
  const hide = step.indexOf("setPlaced(false)");
  const show = step.indexOf("setPlaced(true)");
  expect(hide, "a step never hides the previous step's spotlight").toBeGreaterThan(-1);
  expect(show, "the spotlight is never revealed again").toBeGreaterThan(hide);
  // Revealed only after the connector is drawn — that is the last thing
  // positioned, and revealing before it shows a line pointing at nothing.
  expect(show).toBeGreaterThan(step.indexOf("drawConnector(r)"));
});
