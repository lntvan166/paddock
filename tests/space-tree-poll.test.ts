import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { renderHook, settle, unmount } from "./support/render";
import { useSpaceTree } from "@web/components/use-space-tree";
import type { SpaceTree } from "@shared/types";

afterEach(async () => { await unmount(); });

const TREE: SpaceTree = { readAt: 0, spaces: [] };

/**
 * A tab that is one swipe away is still mounted.
 *
 * `useSpaceTree` paused its 3s poll on `document.hidden`, which was the right
 * question while exactly one screen existed at a time. The pager mounts all
 * three, so the document is visible while Spaces sits off-screen — and two
 * invisible tabs would poll herdr forever, for nobody.
 */

test("an inactive tab reads once and then stops", async () => {
  let loads = 0;
  const load = async () => { loads += 1; return TREE; };
  await renderHook(({ active }: { active: boolean }) => useSpaceTree(load, active), { active: false });
  await settle();
  const afterMount = loads;

  await Bun.sleep(3_400);   // past one poll interval
  await settle();
  expect(loads, "an off-screen tab kept polling herdr").toBe(afterMount);
});

test("an active tab polls", async () => {
  let loads = 0;
  const load = async () => { loads += 1; return TREE; };
  await renderHook(({ active }: { active: boolean }) => useSpaceTree(load, active), { active: true });
  await settle();
  const afterMount = loads;

  await Bun.sleep(3_400);
  await settle();
  expect(loads, "the visible tab stopped polling").toBeGreaterThan(afterMount);
});

test("becoming active catches up immediately", async () => {
  // Waiting out a full interval with a stale screen in front of you is the
  // failure this avoids — the same reasoning the visibilitychange handler
  // beside it already gives.
  let loads = 0;
  const load = async () => { loads += 1; return TREE; };
  const h = await renderHook(
    ({ active }: { active: boolean }) => useSpaceTree(load, active),
    { active: false },
  );
  await settle();
  const before = loads;

  await h.rerender({ active: true });
  await settle();
  expect(loads, "arriving on the tab did not refresh it").toBeGreaterThan(before);
});

test("a slow read is never overlapped by the next poll: one read in flight, one after it", async () => {
  // Measured on a Mac: a tree read took 3–6 s, and a 3 s poll that does not
  // wait stacked reads behind each other on the core's one-call connection.
  let started = 0;
  let inFlight = 0;
  let most = 0;
  const load = async () => {
    started += 1; inFlight += 1; most = Math.max(most, inFlight);
    await Bun.sleep(4_000);
    inFlight -= 1;
    return TREE;
  };
  await renderHook(({ active }: { active: boolean }) => useSpaceTree(load, active), { active: true });
  await Bun.sleep(7_000); // two poll ticks land during the first read
  await settle();
  expect(most, "two reads ran at once").toBe(1);
  // The first read, then exactly one catch-up for the ticks that came meanwhile.
  expect(started).toBe(2);
}, 15_000);
