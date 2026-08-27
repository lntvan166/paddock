// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { TabBar } from "@web/components/TabBar";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

/**
 * The three top-level destinations, at the bottom, labelled.
 *
 * paddock has exactly three — Agents, Spaces, Settings — and reached two of
 * them through 44px icon buttons in the TOP-RIGHT corner, the least reachable
 * point on a phone held in one hand, with no visible label on either.
 *
 * Material 3 puts the floor for a navigation bar at three destinations and
 * says not to remove their labels; Apple says to include tab labels and to use
 * a badge only for critical information. The badge is the part that matters
 * most here: from Spaces or Settings, "an agent needs you" was previously
 * invisible, and that is the single fact this app exists to deliver.
 */

test("renders the three destinations with visible labels", async () => {
  const host = await render(<TabBar current="agents" needsYou={0} onSelect={() => {}} />);
  const items = [...host.querySelectorAll(".tab-item")];
  expect(items.length).toBe(3);
  expect(items.map((i) => i.textContent?.trim())).toEqual(["Agents", "Spaces", "Settings"]);
});

test("marks exactly one destination current, for assistive tech too", async () => {
  const host = await render(<TabBar current="settings" needsYou={0} onSelect={() => {}} />);
  const current = [...host.querySelectorAll('[aria-current="page"]')];
  expect(current.length).toBe(1);
  expect(current[0]?.textContent?.trim()).toBe("Settings");
});

test("badges the Agents tab when something needs you", async () => {
  const host = await render(<TabBar current="settings" needsYou={2} onSelect={() => {}} />);
  const badge = host.querySelector(".tab-badge");
  expect(badge, "a needs-you count must be visible from every screen").not.toBeNull();
  expect(badge!.textContent).toBe("2");
  // The number alone is not a claim anyone can read out; the label carries it.
  expect(badge!.getAttribute("aria-label")).toBe("2 agents need you");
});

test("says 'agent', singular, when exactly one needs you", async () => {
  const host = await render(<TabBar current="agents" needsYou={1} onSelect={() => {}} />);
  expect(host.querySelector(".tab-badge")?.getAttribute("aria-label")).toBe("1 agent needs you");
});

test("shows no badge when nothing needs you", async () => {
  // A zero badge is a permanent red dot that means nothing, which is exactly
  // how a badge stops being read. Apple: "Reserve badges for critical
  // information so you don't dilute their impact and meaning."
  const host = await render(<TabBar current="agents" needsYou={0} onSelect={() => {}} />);
  expect(host.querySelector(".tab-badge")).toBeNull();
});

test("keeps the Spaces tab even when this server has no session tree", async () => {
  // The conflict this resolves: `HostHeader` HID its Spaces control when
  // `spacesAvailable` was false, because in --demo the destination 404s and
  // "an absent control is worse than a working one and far better than a
  // broken one".
  //
  // A three-tab bar cannot lose a tab — two is below the guideline floor, and
  // Apple is explicit: "Don't disable or hide tab bar buttons, even when their
  // content is unavailable… If a section is empty, explain why its content is
  // unavailable." So the tab stays and the DESTINATION is made honest instead;
  // the original objection was that it errored, not that it existed.
  const host = await render(<TabBar current="agents" needsYou={0} onSelect={() => {}} />);
  expect([...host.querySelectorAll(".tab-item")].map((i) => i.textContent?.trim()))
    .toContain("Spaces");
});
