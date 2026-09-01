import "./styles.css";
import "./tour/overlay.css";
import { SECTIONS, sectionForScroll } from "@site/page";
import { createTour } from "@site/tour/engine";
import { TOUR_STEPS, type TourStep } from "@site/tour/steps";
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
/* `?embed` tells the demo it is inside the site's phone rather than being read
   on a real one, which is what turns on the height rules in `demo/frame.css`.
   The tour steers by hash, so the query survives every step. */
const APP_SRC = "/app/?embed=1";
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
      <!-- The same build with no page around it. On a phone that is
           indistinguishable from the installed PWA, which is the strongest
           thing this site can show, and it used to be reachable only by typing
           the path. A NEW TAB: the landing page keeps its place and its tour,
           so the two run side by side rather than one replacing the other.
           Relative, so it works on a preview deployment and on localhost. -->
      <a class="fullscreen" href="/app/" target="_blank" rel="noopener">Open full screen &#8599;</a>
    </div>
  </div>
`;

const frame = root.querySelector<HTMLIFrameElement>(".demo")!;

/**
 * Bring an anchor into view WITHOUT switching the app's tab.
 *
 * `scrollIntoView` walks every scrollable ancestor, and one of them is the
 * pager's horizontal track: moving it fires the pager's own index change, which
 * rewrites the URL to whichever tab it landed on. Measured — a step that
 * navigated to `#/spaces` was dragged to `#/` about a second later, by the
 * tour's own scroll, and the two steps that used a tab hash appeared never to
 * navigate at all.
 *
 * So only the nearest VERTICAL scroller moves, and nothing horizontal is
 * touched. If there is none, the anchor is already where the frame can show it.
 */
function bringIntoView(el: HTMLElement): void {
  let node: HTMLElement | null = el.parentElement;
  const view = el.ownerDocument.defaultView;
  if (!view) return;
  while (node) {
    const style = view.getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
      const a = el.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      node.scrollTop += a.top + a.height / 2 - (box.top + box.height / 2);
      return;
    }
    node = node.parentElement;
  }
}

/** The pane a step addresses, taken from the hash it navigates to. */
function paneOf(hash: string): string | null {
  const m = /^#\/(?:pane|agent)\/(.+)$/.exec(hash);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * Do the thing the step just described, through the demo's OWN routes.
 *
 * Not by driving its DOM: the demo already simulates these — `answer` unblocks
 * the agent, `text` echoes the reply into the transcript — so asking it the way
 * the app asks it is both less code and a genuine exercise of the same path.
 * The demo is synthetic throughout, so "real" here means the visitor sees the
 * state the control produces, which is all a demonstration owes them.
 *
 * Failures are swallowed on purpose, and only here: a demo that would not
 * answer must not strand the visitor mid-tour with a Next that does nothing.
 * The step still advances.
 */
async function perform(step: TourStep): Promise<void> {
  const pane = paneOf(step.hash);
  if (step.act === undefined || pane === null) return;
  const win = frame.contentWindow;
  // Same rule as `goto`: before load this is the blank document, whose `fetch`
  // is not the demo backend and would post the tour's answer into the void.
  if (!win || !frameReady) return;
  const url = `/api/agents/${encodeURIComponent(pane)}/`;
  const body = step.act === "send-reply" ? { text: step.reply ?? "" } : { key: "1" };
  try {
    await win.fetch(url + (step.act === "send-reply" ? "text" : "answer"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // The app polls; give it a beat to repaint before the next step measures.
    await new Promise((r) => setTimeout(r, 400));
  } catch {
    // Deliberately ignored — see above.
  }
}
const stepFor = (anchor: string) => TOUR_STEPS.find((s) => s.anchor === anchor);

/**
 * The frame is not driven until it has LOADED, and this is why the phone was
 * white in Safari for three rounds.
 *
 * `contentWindow` exists the moment the iframe is in the document — but it is
 * the INITIAL blank document, not `/app/?embed=1`, which is still in flight.
 * Setting a hash on it is a same-document navigation, and WebKit lets that win:
 * the pending load is cancelled and the frame stays on `about:blank#/` for
 * good. Chromium lets the `src` load win instead, so every measurement taken in
 * it looked perfect while Safari showed a white rectangle.
 *
 * Reproduced in WebKit 26.5, which is also what finally identified it:
 *   webkit    url=about:blank#/     rootKids=NO ROOT
 *   chromium  url=/app/?embed=1     rootKids=1
 *
 * The IntersectionObserver below fires its first callback immediately, so this
 * runs during page load every single time. It is not a race.
 */
let frameReady = false;
/** The last route asked for too early. Dropping it would leave the phone
 *  showing whatever `src` named while the copy has scrolled somewhere else. */
let pendingHash: string | null = null;

frame.addEventListener("load", () => {
  frameReady = true;
  if (pendingHash === null) return;
  const hash = pendingHash;
  pendingHash = null;
  goto(hash);
});

/** Hash-only routing means this is the whole of "drive the demo". */
function goto(hash: string): void {
  if (!frameReady) {
    pendingHash = hash;
    return;
  }
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
/** Takes every click the tour is not offering. See overlay.css. */
const block = document.createElement("div");
hole.className = "tour-hole";
callout.className = "tour-callout";
block.className = "tour-block";

/**
 * Show or hide the three marks together.
 *
 * They are positioned at different moments — the hole after the anchor exists,
 * the callout after the hole, the connector after the callout has a height —
 * so revealing each as it lands would stagger them across three frames. One
 * flag, set once at the end, is what makes the step arrive as a single thing.
 */
function setPlaced(on: boolean): void {
  for (const el of [hole, line, callout]) el.classList.toggle("is-placed", on);
}

const SVG_NS = "http://www.w3.org/2000/svg";
const line = document.createElementNS(SVG_NS, "svg");
const stroke = document.createElementNS(SVG_NS, "line");
const dot = document.createElementNS(SVG_NS, "circle");
line.setAttribute("class", "tour-line");
dot.setAttribute("r", "3");
line.append(stroke, dot);

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
  onStep: (step, i) => {
    callout.innerHTML = `
      <h3>0${i + 1} · ${escapeHtml(step.title)}</h3>
      <p>${escapeHtml(step.body)}</p>
      <div class="tour-controls">
        <button type="button" class="tour-skip">Skip</button>
        <button type="button" class="tour-next">${
          i + 1 === TOUR_STEPS.length ? "Done" : "Next"
        }</button>
      </div>`;

    callout.querySelector(".tour-skip")!.addEventListener("click", () => tour.skip());
    callout.querySelector(".tour-next")!.addEventListener("click", (e) => {
      // Disabled while the act runs, so a second tap cannot answer twice or
      // skip the step whose effect is still arriving.
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      void perform(step).finally(() => tour.next());
    });

    // Hidden BEFORE the route changes. The old rect describes the old screen,
    // and the phone is about to repaint under it.
    setPlaced(false);
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
        // there yet. Bring it into the middle of the frame first, vertically
        // ONLY: see `bringIntoView` for what the horizontal half did.
        bringIntoView(el);

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
            // Everything is where it belongs; show all three at once.
            setPlaced(true);
          });
        });

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
    hole.remove();
    callout.remove();
    line.remove();
    // Left behind, this is an invisible sheet over a page nobody can use again.
    block.remove();
    document.body.classList.remove("tour-on");
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
  // Blurs the copy and leaves the phone alone. See overlay.css.
  document.body.classList.add("tour-on");
  document.body.append(block, hole, line, callout);

  /**
   * A clean demo every time the tour starts.
   *
   * The tour ANSWERS the blocked agent and sends a reply, so a second run would
   * otherwise open on the wreckage of the first: nothing blocked, a transcript
   * already replied to, and step two pointing at options that are gone. The
   * demo's state is module-level inside the frame, so a reload is a guaranteed
   * reset rather than a hand-written undo that has to be kept in step with it.
   */
  frame.addEventListener("load", () => tour.start(), { once: true });
  /**
   * Home BEFORE the reload, not after.
   *
   * The demo stays live between tours, so a visitor who explored and left it
   * on Spaces got a second tour whose step 01 described the agent list while
   * the phone showed something else. `reload()` does not fix that on its own —
   * it keeps the whole URL, fragment included. Setting the route first is a
   * same-document navigation that lands instantly, so the reload that follows
   * starts from the dashboard and there is no wrong screen to flash through.
   */
  goto("#/");
  // The listener registered at module scope runs first and sets it back.
  frameReady = false;
  frame.contentWindow?.location.reload();
});
