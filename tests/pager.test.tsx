import "./support/dom";
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { PAGER_TABS, Pager } from "@web/components/Pager";
import { render, settle, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

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
  await render(<Pager index={0} onIndexChange={() => {}} />);
  await settle();
  expect(document.querySelectorAll(".pager-page").length).toBe(3);
});

test("the pages are in tab order", async () => {
  await render(<Pager index={0} onIndexChange={() => {}} />);
  await settle();
  const ids = [...document.querySelectorAll(".pager-page")]
    .map((p) => (p as HTMLElement).dataset.tab);
  expect(ids).toEqual([...PAGER_TABS]);
});

test("the track is offset by whole pages", async () => {
  const host = await render(<Pager index={0} onIndexChange={() => {}} />);
  await settle();
  const track = document.querySelector(".pager-track") as HTMLElement;
  expect(track.style.transform).toContain("0%");

  await render(<Pager index={2} onIndexChange={() => {}} />, host);
  await settle();
  const after = document.querySelector(".pager-track") as HTMLElement;
  expect(after.style.transform, "the track did not move to the third page").toContain("-200%");
});

test("only the front page is exposed to assistive tech", async () => {
  // Three mounted screens means two of them are off-screen but present. Left
  // unmarked, a screen reader reads all three as one long page and the tab bar
  // stops meaning anything.
  await render(<Pager index={1} onIndexChange={() => {}} />);
  await settle();
  const pages = [...document.querySelectorAll(".pager-page")] as HTMLElement[];
  expect(pages.map((p) => p.getAttribute("aria-hidden"))).toEqual(["true", null, "true"]);
});

test("the track carries no tab bar", async () => {
  // The bar is AppShell's, outside the transitioning region. One inside the
  // track would be three bars again — and they would slide with the content.
  await render(<Pager index={0} onIndexChange={() => {}} />);
  await settle();
  expect(document.querySelectorAll(".tab-bar").length).toBe(0);
});

test("the track's order and the tab bar's order are the same list", () => {
  // The pager moves by index and the bar labels by key. If these two ever
  // disagree, tapping "Spaces" slides to Settings — and nothing else in the
  // suite would notice.
  const bar = readFileSync("src/web/components/TabBar.tsx", "utf8");
  const order = [...bar.matchAll(/key:\s*"(agents|spaces|settings)"/g)].map((m) => m[1]);
  expect(order).toEqual([...PAGER_TABS]);
});
