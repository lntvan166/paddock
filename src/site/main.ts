import "./styles.css";
import "./tour/overlay.css";
import { SECTIONS, sectionForScroll } from "@site/page";
import { createTour } from "@site/tour/engine";
import { TOUR_STEPS } from "@site/tour/steps";
import { awaitAnchor, spotlightRect } from "@site/tour/spotlight";

/**
 * The landing page.
 *
 * Two gears. Gear one is reading: the phone is pinned and follows whichever
 * section is most visible. Gear two is the tour, which you enter deliberately —
 * a full scrim with one control lit is inherently modal, and cannot also be a
 * scroll effect without two drivers fighting each other.
 *
 * The demo is the real app in a same-origin iframe. Routing is hash-only
 * (src/web/route.ts), so steering it is one assignment and no component changes.
 *
 * THE HERO IS NOT RENDERED HERE. It is static markup in site/index.html,
 * because a crawler, a link unfurler and a reader with JavaScript off all
 * receive the HTML and none of them run this file — building the headline at
 * runtime meant every link preview of this page was an empty box. This module
 * fills the two holes that markup leaves and never overwrites it.
 */
const APP_SRC = "/app/";
const root = document.getElementById("site")!;
const splitMount = document.getElementById("split")!;
const heroActions = document.getElementById("hero-actions")!;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

heroActions.innerHTML = `
  <button type="button" class="tour-start">Take the tour</button>
  <p class="hint">Or scroll — the phone follows along, and you can tap it any time.</p>
`;

splitMount.outerHTML = `
  <div class="split">
    <div class="copy">
      ${SECTIONS.map(
        (s, i) => `<section class="sec" data-section="${s.anchor}">
          <span class="num">0${i + 1}</span>
          <h2>${escapeHtml(s.heading)}</h2>
          <p>${escapeHtml(s.body)}</p>
        </section>`,
      ).join("")}
    </div>
    <div class="phone-rail">
      <div class="phone">
        <iframe class="demo" src="${APP_SRC}" title="paddock, running against synthetic agents"></iframe>
      </div>
    </div>
  </div>
`;

const frame = root.querySelector<HTMLIFrameElement>(".demo")!;
const stepFor = (anchor: string) => TOUR_STEPS.find((s) => s.anchor === anchor);

/** Hash-only routing means this is the whole of "drive the demo". */
function goto(hash: string): void {
  if (frame.contentWindow) frame.contentWindow.location.hash = hash;
}

// --- gear one: the phone follows the copy ------------------------------------
let following = true;
const stopFollowing = (): void => { following = false; };
frame.addEventListener("mouseenter", stopFollowing);
frame.addEventListener("touchstart", stopFollowing, { passive: true });

const ratios = new Map<string, number>();
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      ratios.set((e.target as HTMLElement).dataset.section!, e.intersectionRatio);
    }
    if (!following) return;
    const anchor = sectionForScroll([...ratios].map(([a, ratio]) => ({ anchor: a, ratio })));
    const step = anchor ? stepFor(anchor) : undefined;
    if (step) goto(step.hash);
  },
  { threshold: [0, 0.25, 0.5, 0.75, 1] },
);
for (const el of root.querySelectorAll(".sec")) observer.observe(el);
// Scrolling to a new section resumes following, after a visitor has explored.
addEventListener("scroll", () => { following = true; }, { passive: true });

// --- gear two: the tour ------------------------------------------------------
const hole = document.createElement("div");
const callout = document.createElement("div");
hole.className = "tour-hole";
callout.className = "tour-callout";

const SVG_NS = "http://www.w3.org/2000/svg";
const line = document.createElementNS(SVG_NS, "svg");
const stroke = document.createElementNS(SVG_NS, "line");
const dot = document.createElementNS(SVG_NS, "circle");
line.setAttribute("class", "tour-line");
dot.setAttribute("r", "3");
line.append(stroke, dot);

let raf = 0;

/**
 * Which step's measurement is still wanted.
 *
 * `awaitAnchor` resolves asynchronously, so a step that has already been
 * superseded — by a fast click, or by Skip — can still come back and write its
 * rect over the current step's. That reads as a spotlight pointing at the wrong
 * control, with nothing in the console to explain it.
 */
let token = 0;

const tour = createTour({
  steps: TOUR_STEPS,
  hintAfterMs: 3000,
  onStep: (step, i) => {
    callout.innerHTML = `
      <h3>0${i + 1} · ${escapeHtml(step.title)}</h3>
      <p>${escapeHtml(step.body)}</p>
      <div class="tour-controls">
        ${
          step.advance === "next"
            ? '<button type="button" class="tour-next">Next</button>'
            : '<button type="button" class="tour-showme" hidden>Show me</button>'
        }
        <button type="button" class="tour-skip">Skip</button>
      </div>`;

    callout.querySelector(".tour-skip")!.addEventListener("click", () => tour.skip());
    callout.querySelector(".tour-next")?.addEventListener("click", () => tour.satisfy(step.anchor));

    callout.querySelector(".tour-showme")?.addEventListener("click", () => {
      const el = frame.contentDocument?.querySelector<HTMLElement>(
        `[data-tour="${step.anchor}"]`,
      );
      // Do the thing the step asked for, rather than skipping past it — the
      // click fires the same listener a real tap would, which is what advances.
      if (el) el.click();
      // And satisfy by ANCHOR, not by index: if the click above already
      // advanced, this no longer matches the current step and is ignored.
      // Calling showMe() here instead advanced a second time, and 01 jumped
      // straight to 03.
      tour.satisfy(step.anchor);
    });

    goto(step.hash);
    const mine = ++token;

    const doc = frame.contentDocument;
    if (!doc) return;

    // NEVER measure in this tick — the hash change has not repainted yet, and
    // the rect would belong to the previous screen. See spotlight.ts.
    void awaitAnchor(doc, step.anchor)
      .then((el) => {
        if (mine !== token) return;   // a later step already owns the hole

        // The phone scrolls too. An anchor near the bottom of a screen sits
        // below the phone's own fold, and its rect is then a position nobody
        // can see — the spotlight lands on a control that is genuinely not
        // there yet. Bring it into the middle of the frame first.
        el.scrollIntoView({ block: "center", inline: "nearest" });

        // And measure only after that scroll has been applied. Same rule as
        // waiting for the repaint above: reading the rect in this tick reads
        // the position from BEFORE the scroll, which is the bug that rule
        // exists to prevent, one frame later.
        requestAnimationFrame(() => {
          if (mine !== token) return;
          const r = spotlightRect(el, frame);
          hole.style.left = `${r.x}px`;
          hole.style.top = `${r.y}px`;
          hole.style.width = `${r.width}px`;
          hole.style.height = `${r.height}px`;
          placeCallout(r);
          // And the connector only once the callout itself has been laid out —
          // which is also the first moment its height is known, and therefore
          // the first moment it can be kept inside the window.
          requestAnimationFrame(() => {
            if (mine !== token) return;
            clampCallout();
            drawConnector(r);
          });
        });

        // A `next` step has nothing here to wait for — the tour navigated, and
        // the step exists to show what arrived. It advances on its own control,
        // wired below, never on the anchor merely existing.
        if (step.advance === "click") {
          el.addEventListener("click", () => tour.satisfy(step.anchor), {
            once: true,
            capture: true,
          });
        }
      })
      .catch((err: unknown) => {
        if (mine !== token) return;
        // Never swallowed. A missing anchor means the contract test is stale,
        // and a silent skip would hide exactly that.
        console.error(err);
        tour.skip();
      });
  },
  onEnd: () => {
    cancelAnimationFrame(raf);
    hole.remove();
    callout.remove();
    line.remove();
    document.documentElement.style.overflow = "";
  },
});

/**
 * Put the callout in the dark, beside the lit control.
 *
 * On a wide window it sits outside the phone's bezel, where a full measure of
 * text fits. Below the breakpoint the stylesheet docks it to the bottom edge
 * instead — there is no outside there — so this only sets the vertical
 * position and lets CSS win on the horizontal.
 */
function placeCallout(r: { x: number; y: number; width: number; height: number }): void {
  const wide = window.matchMedia("(min-width: 1000px)").matches;
  if (!wide) return;
  const right = r.x + r.width + 24;
  const fits = right + 360 < window.innerWidth;
  callout.style.left = fits ? `${right}px` : "";
  callout.style.right = fits ? "" : `${window.innerWidth - r.x + 24}px`;
  callout.style.top = `${Math.max(16, r.y)}px`;
}

/**
 * Keep the callout inside the window.
 *
 * `placeCallout` aligns its TOP with the lit control, which puts it off the
 * bottom whenever the control sits low — the reply field did exactly that, and
 * the step's text was simply not on screen. Its height is unknown until it has
 * been laid out, so the clamp has to happen a frame later, not in the placement.
 *
 * Below the breakpoint the stylesheet docks it to the bottom edge and owns both
 * axes, so there is nothing to clamp.
 */
function clampCallout(): void {
  if (!window.matchMedia("(min-width: 1000px)").matches) return;
  const c = callout.getBoundingClientRect();
  const top = Math.min(Math.max(16, c.y), window.innerHeight - c.height - 16);
  callout.style.top = `${Math.max(16, top)}px`;
}

/**
 * Join the callout to the control it describes.
 *
 * From the callout's nearest vertical edge to the hole's nearest one, so the
 * line never crosses the callout itself. Both ends come from live rects rather
 * than from the placement arithmetic, because the stylesheet owns the
 * horizontal below the breakpoint and only the browser knows where the callout
 * actually ended up.
 */
function drawConnector(r: { x: number; y: number; width: number; height: number }): void {
  const c = callout.getBoundingClientRect();
  const holeMidY = r.y + r.height / 2;
  const calloutMidY = c.y + c.height / 2;
  const calloutRight = c.x + c.width;

  // Whichever side of the hole the callout landed on.
  const leftOfHole = calloutRight <= r.x;
  const fromX = leftOfHole ? calloutRight : c.x;
  const toX = leftOfHole ? r.x : r.x + r.width;

  stroke.setAttribute("x1", String(fromX));
  stroke.setAttribute("y1", String(calloutMidY));
  stroke.setAttribute("x2", String(toX));
  stroke.setAttribute("y2", String(holeMidY));
  dot.setAttribute("cx", String(toX));
  dot.setAttribute("cy", String(holeMidY));
}

root.querySelector(".tour-start")!.addEventListener("click", () => {
  // Bring the phone fully into view BEFORE locking, or the tour spotlights a
  // control that is off the bottom of the window: the button lives in the hero,
  // where the phone is barely peeking, and locking there freezes it that way.
  document.querySelector(".phone")!.scrollIntoView({ block: "center" });

  // Then lock. The hole is registered to the frame's on-screen position, so a
  // scroll behind the scrim desynchronises it from what it points at — and a
  // takeover should not scroll anyway.
  document.documentElement.style.overflow = "hidden";
  document.body.append(hole, line, callout);

  const loop = (t: number): void => {
    tour.tick(t);
    const showme = callout.querySelector<HTMLButtonElement>(".tour-showme");
    if (showme) showme.hidden = !tour.hintVisible();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  tour.start();
});
