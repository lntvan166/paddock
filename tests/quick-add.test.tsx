import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { QuickAdd } from "@web/components/QuickAdd";
import { CreateSheet } from "@web/components/CreateSheet";
import type { CreateSenders } from "@web/components/CreateSheet";
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

const TREE = { readAt: 0, spaces: [] };

const senders: CreateSenders = {
  harnesses: async () => ["claude", "codex"],
  createSpace: async () => ({ ok: true, spaceId: "w9", tabId: "w9:t1", paneId: "w9:p1" }),
  createTab: async () => ({ ok: true, tabId: "w9:t2", paneId: "w9:p2" }),
  startAgent: async () => ({ ok: true, paneId: "w9:p1", name: "api-refactor", kind: "claude" }),
};

test("the trigger is a single control until it is opened", async () => {
  const host = await render(<QuickAdd onChanged={() => {}} senders={senders} load={async () => TREE} />);
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
  const host = await render(<QuickAdd onChanged={() => {}} senders={senders} load={async () => TREE} />);
  await settle();
  await pointerOpen(host.querySelector(".quick-add-fab"));
  await settle();
  const items = [...document.querySelectorAll(".quick-add-item")].map((n) => n.textContent?.trim());
  expect(items).toEqual(["Agent", "Terminal"]);
});

test("the trigger says which state it is in, for assistive tech too", async () => {
  // Colour and a rotated glyph reach nobody using a screen reader. Radix sets
  // `aria-expanded`; the label is ours and has to agree with it.
  const host = await render(<QuickAdd onChanged={() => {}} senders={senders} load={async () => TREE} />);
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
  const host = await render(<QuickAdd onChanged={() => {}} senders={senders} load={async () => TREE} />);
  await settle();
  await pointerOpen(host.querySelector(".quick-add-fab"));
  await settle();
  const terminal = [...document.querySelectorAll(".quick-add-item")]
    .find((n) => n.textContent?.trim() === "Terminal")!;
  await click(terminal);
  await settle();
  const sheet = document.querySelector(".create-sheet, .row-actions-sheet");
  expect(sheet, "the create sheet did not open").not.toBeNull();
  // Titled for what was ASKED FOR, not for the record produced — the
  // description one line down still says a space is what gets made.
  expect(sheet!.textContent).toContain("New terminal");
  expect(sheet!.textContent).toContain("A new space, with one tab and one pane in it.");
});

test("the dial renders no trigger of its own inside the sheet", async () => {
  // `CreateSheet` normally carries its own `+`. Driven from here it must not,
  // or the sheet contains a control that reopens the sheet it is already in.
  const host = await render(<QuickAdd onChanged={() => {}} senders={senders} load={async () => TREE} />);
  await settle();
  await pointerOpen(host.querySelector(".quick-add-fab"));
  await settle();
  await click([...document.querySelectorAll(".quick-add-item")][1]);
  await settle();
  expect(document.querySelectorAll("[data-create]").length).toBe(0);
});

test("quick mode asks for a name and a folder, and nothing already answered", async () => {
  // The point of the dial is speed. Two of the sheet's four fields are already
  // decided by the time it opens: the picker (by which entry was tapped) and
  // the agent name (derived from the one name typed — see `nameSource`). A
  // second box showing a slug of the box above it is a repetition, not a
  // decision.
  const host = await render(
    <QuickAdd onChanged={() => {}} senders={senders} load={async () => TREE} />,
  );
  await settle();
  await pointerOpen(host.querySelector(".quick-add-fab"));
  await settle();
  await click([...document.querySelectorAll(".quick-add-item")][0]);  // Agent
  await settle();

  const labels = [...document.querySelectorAll(".create-form label span")]
    .map((n) => n.textContent?.trim());
  expect(labels).toEqual(["Name", "Folder"]);
});

test("the normal create flow still asks everything", async () => {
  // Guards the guard: `quick` keys off `preset`, which only `QuickAdd` passes.
  // If that ever leaked to the header and row controls, they would silently
  // stop asking which harness to start.
  const host = await render(
    <CreateSheet target={{ kind: "space" }} cwds={[]} onChanged={() => {}} senders={senders} />,
  );
  await settle();
  await click(host.querySelector("[data-create]"));
  await settle();
  const labels = [...document.querySelectorAll(".create-form label span")]
    .map((n) => n.textContent?.trim());
  expect(labels).toContain("Space name");
  expect(labels).toContain("Start");
});

test("the folder picker is offered the tree's own folders", async () => {
  // Reported from a phone: typing a path from memory is the worst input this
  // app asks for. The dial shipped with an empty pick list, which made it the
  // only create control offering no help at all.
  const tree = {
    readAt: 0,
    spaces: [{
      spaceId: "w1", label: "api refactor", tabCount: 1, paneCount: 1,
      tabs: [{ tabId: "w1:t1", label: null, panes: [
        { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: null,
          cwd: "~/project", state: "idle" as const },
      ] }],
    }],
  };
  const host = await render(
    <QuickAdd onChanged={() => {}} senders={senders} load={async () => tree} />,
  );
  await settle();
  await pointerOpen(host.querySelector(".quick-add-fab"));
  await settle();
  await click([...document.querySelectorAll(".quick-add-item")][1]);  // Terminal
  await settle();
  await settle();
  const picks = [...document.querySelectorAll(".create-cwds > button")].map((b) => b.textContent);
  expect(picks, "the tree's folders are not offered as quick picks").toContain("~/project");
});

test("choosing Agent titles the sheet for the agent, not the record", async () => {
  const host = await render(
    <QuickAdd onChanged={() => {}} senders={senders} load={async () => TREE} />,
  );
  await settle();
  await pointerOpen(host.querySelector(".quick-add-fab"));
  await settle();
  await click([...document.querySelectorAll(".quick-add-item")][0]);
  await settle();
  expect(document.querySelector(".row-actions-title")?.textContent).toBe("New agent");
});
