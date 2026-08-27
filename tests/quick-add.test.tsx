import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { QuickAdd } from "@web/components/QuickAdd";
import { click, pointerOpen, render, settle, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

/**
 * The dashboard's create dial.
 *
 * What is asserted here is the STRUCTURE and the wiring — that the two entries
 * exist, that they are what the create sheet's first field already asks, and
 * that choosing one pre-answers it. The behaviours that make a dial usable
 * (Escape, an outside tap, focus into the items and back to the trigger, roving
 * arrow keys, scroll lock) are Radix's and are deliberately NOT re-tested here:
 * testing a dependency's own contract through our markup asserts nothing about
 * this file and breaks when it improves.
 */

const senders = {
  createSpace: async () => ({ spaceId: "w9", tabId: "w9:t1", paneId: "w9:p1" }),
  createTab: async () => ({ tabId: "w9:t2", paneId: "w9:p2" }),
  startAgent: async () => {},
  harnessKinds: async () => ["claude", "codex"],
};

test("the trigger is a single control until it is opened", async () => {
  const host = await render(<QuickAdd cwds={[]} onChanged={() => {}} senders={senders} />);
  await settle();
  const fab = host.querySelector(".quick-add-fab");
  expect(fab, "no dial trigger").not.toBeNull();
  expect(fab!.getAttribute("aria-label")).toBe("New");
  // Closed, the actions do not exist — they are not merely hidden. A menu
  // rendered-but-invisible is reachable by keyboard and read by a screen
  // reader, which is the failure this shape avoids.
  expect(host.querySelectorAll(".quick-add-item").length).toBe(0);
});

test("opening offers exactly the two answers the sheet's first field asks", async () => {
  // `plain shell — no agent` versus a harness kind. If a third entry appears
  // here that does NOT correspond to a field the sheet already asks, the dial
  // has started inventing choices rather than pre-answering them.
  const host = await render(<QuickAdd cwds={[]} onChanged={() => {}} senders={senders} />);
  await settle();
  await pointerOpen(host.querySelector(".quick-add-fab"));
  await settle();
  const items = [...document.querySelectorAll(".quick-add-item")].map((n) => n.textContent?.trim());
  expect(items).toEqual(["Agent", "Terminal"]);
});

test("the trigger says which state it is in, for assistive tech too", async () => {
  // Colour and a rotated glyph reach nobody using a screen reader. Radix sets
  // `aria-expanded`; the label is ours and has to agree with it.
  const host = await render(<QuickAdd cwds={[]} onChanged={() => {}} senders={senders} />);
  await settle();
  const fab = host.querySelector(".quick-add-fab")!;
  expect(fab.getAttribute("aria-expanded")).toBe("false");
  await pointerOpen(fab);
  await settle();
  expect(fab.getAttribute("aria-expanded")).toBe("true");
  expect(fab.getAttribute("aria-label")).toBe("Close");
});

test("choosing Terminal opens the sheet on a new SPACE", async () => {
  // A space, not a tab: from the dashboard there is no tab to add to. That is
  // what the space screen's own "New tab" row is for.
  const host = await render(<QuickAdd cwds={[]} onChanged={() => {}} senders={senders} />);
  await settle();
  await pointerOpen(host.querySelector(".quick-add-fab"));
  await settle();
  const terminal = [...document.querySelectorAll(".quick-add-item")]
    .find((n) => n.textContent?.trim() === "Terminal")!;
  await click(terminal);
  await settle();
  const sheet = document.querySelector(".create-sheet, .row-actions-sheet");
  expect(sheet, "the create sheet did not open").not.toBeNull();
  expect(sheet!.textContent).toContain("New space");
});

test("the dial renders no trigger of its own inside the sheet", async () => {
  // `CreateSheet` normally carries its own `+`. Driven from here it must not,
  // or the sheet contains a control that reopens the sheet it is already in.
  const host = await render(<QuickAdd cwds={[]} onChanged={() => {}} senders={senders} />);
  await settle();
  await pointerOpen(host.querySelector(".quick-add-fab"));
  await settle();
  await click([...document.querySelectorAll(".quick-add-item")][1]);
  await settle();
  expect(document.querySelectorAll("[data-create]").length).toBe(0);
});
