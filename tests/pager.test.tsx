import "./support/dom";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { PAGER_TABS, Pager } from "@web/components/Pager";
import { render, settle, stubFetch, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

// The pager mounts all three real screens, and two of them poll. Without a
// stub those requests hit the global `fetch` — which `stubFetch` makes a
// SINGLE shared slot — so a poller here can record into another test file's
// call log and fail an assertion that has nothing to do with the pager. It
// did exactly that to `prefs-applied.test.tsx`.
beforeEach(() => {
  stubFetch({
    "/api/spaces": () => ({ readAt: 0, spaces: [] }),
    "/api/agents": () => ({ agents: [] }),
    "/api/health": () => ({ ok: true }),
    "/api/settings": () => ({ notify: { triggers: [] }, push: { enabled: false, devices: 0 } }),
  });
});

/**
 * The track that holds the three tab destinations.
 *
 * What is asserted here is STRUCTURE — that all three are mounted, in order,
 * and that the transform follows the index. The FEEL (rubber-band, flick
 * commit) is arithmetic and lives in `tests/pager-gesture.test.ts`; the
 * geometry is verified in a real browser, because happy-dom has no layout.
 */

test("all three destinations are mounted at once", async () => {
  // This is the property the whole design rests on. Finger-tracking needs the
  // neighbouring screen already on screen when the drag begins — there is no
  // time to mount one. It is also what deletes the Spaces reload bug: a screen
  // that never unmounts never resets to its empty state.
  const host = await render(<Pager index={0} onIndexChange={() => {}} />);
  await settle();
  expect(host.querySelectorAll(".pager-page").length).toBe(3);
});

test("the pages are in tab order", async () => {
  const host = await render(<Pager index={0} onIndexChange={() => {}} />);
  await settle();
  const ids = [...host.querySelectorAll(".pager-page")]
    .map((p) => (p as HTMLElement).dataset.tab);
  expect(ids).toEqual([...PAGER_TABS]);
});

test("the track is offset by whole pages", async () => {
  const host = await render(<Pager index={0} onIndexChange={() => {}} />);
  await settle();
  const track = host.querySelector(".pager-track") as HTMLElement;
  expect(track.style.transform).toContain("0%");

  await render(<Pager index={2} onIndexChange={() => {}} />, host);
  await settle();
  const after = host.querySelector(".pager-track") as HTMLElement;
  expect(after.style.transform, "the track did not move to the third page").toContain("-200%");
});

test("only the front page is exposed to assistive tech", async () => {
  // Three mounted screens means two of them are off-screen but present. Left
  // unmarked, a screen reader reads all three as one long page and the tab bar
  // stops meaning anything.
  const host = await render(<Pager index={1} onIndexChange={() => {}} />);
  await settle();
  const pages = [...host.querySelectorAll(".pager-page")] as HTMLElement[];
  expect(pages.map((p) => p.getAttribute("aria-hidden"))).toEqual(["true", null, "true"]);
});

test("the track carries no tab bar", async () => {
  // The bar is AppShell's, outside the transitioning region. One inside the
  // track would be three bars again — and they would slide with the content.
  const host = await render(<Pager index={0} onIndexChange={() => {}} />);
  await settle();
  expect(host.querySelectorAll(".tab-bar").length).toBe(0);
});

test("the track's order and the tab bar's order are the same list", () => {
  // The pager moves by index and the bar labels by key. If these two ever
  // disagree, tapping "Spaces" slides to Settings — and nothing else in the
  // suite would notice.
  const bar = readFileSync("src/web/components/TabBar.tsx", "utf8");
  const order = [...bar.matchAll(/key:\s*"(agents|spaces|settings)"/g)].map((m) => m[1]);
  expect(order).toEqual([...PAGER_TABS]);
});

test("the track claims no compositor layer when it is still", async () => {
  // Reported from a phone: after a swipe finished, the screen would not scroll
  // until it was tapped once.
  //
  // `will-change: transform` used to sit on the base rule, promoting the track
  // to its own compositor layer permanently. On iOS a promoted ancestor can
  // leave a descendant's scrolling inert until something forces a repaint, and
  // the tap was that something. `will-change` is meant to be transient.
  const css = readFileSync("src/web/styles.css", "utf8");
  const base = /\.pager-track \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(base, "the resting track still promotes itself to its own layer")
    .not.toContain("will-change");
  // It must still be there for the states that actually move, or the animation
  // gives up the optimisation entirely.
  expect(css).toMatch(/\.pager-track\.is-dragging[\s\S]{0,120}will-change/);
});

test("a finished settle drops the classes that describe movement", async () => {
  // Otherwise `is-settling` outlives the transition and takes will-change with
  // it, which is the same bug wearing a different class name.
  const host = await render(<Pager index={0} onIndexChange={() => {}} />);
  const track = host.querySelector(".pager-track")! as HTMLElement;
  track.classList.add("is-settling", "is-dragging");

  track.dispatchEvent(new Event("transitionend", { bubbles: true }));
  await settle();

  expect(track.classList.contains("is-settling"), "is-settling outlived the transition").toBe(false);
  expect(track.classList.contains("is-dragging"), "is-dragging outlived the transition").toBe(false);
  expect(host).toBeDefined();
});
