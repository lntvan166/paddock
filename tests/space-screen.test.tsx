import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { click, render, textsOf, unmount } from "./support/render";
import { Space } from "@web/components/Space";
import { useStore } from "@web/store";
import type { SpaceTree } from "@shared/types";

afterEach(async () => {
  await unmount();
  // Module state, and `bun test` shares a module registry across FILES: a
  // capability left set here would leak into another file's expectations.
  // `tests/create-sheet.test.tsx` carries the same reset for the same reason.
  useStore.setState({ spacesAvailable: false });
});

const TREE: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [
    {
      spaceId: "w1", label: "schema-migration", tabCount: 2, paneCount: 3,
      tabs: [
        { tabId: "w1:t1", label: "migrate-up", panes: [
          { paneId: "w1:p1", harness: "codex", name: "schema-migration", title: "t", cwd: "/srv/project", state: "working" },
        ] },
        { tabId: "w1:t2", label: "backfill", panes: [
          { paneId: "w1:p2", harness: "claude", name: "schema-migration-2", title: "t", cwd: "/srv/project", state: "idle" },
          { paneId: "w1:p3", harness: null, name: null, title: "bash", cwd: "/srv/project/logs", state: null },
        ] },
      ],
    },
    {
      spaceId: "w2", label: "docs-cleanup", tabCount: 1, paneCount: 1,
      tabs: [{ tabId: "w2:t1", label: null, panes: [
        { paneId: "w2:p1", harness: "claude", name: "docs-cleanup", title: "t", cwd: "/srv/project", state: "blocked" },
      ] }],
    },
  ],
};

const load = (t: SpaceTree) => async () => t;

test("the screen lists the space's TABS, one row each", async () => {
  const host = await render(<Space spaceId="w1" onBack={() => {}} load={load(TREE)} />);
  expect(host.querySelectorAll("[data-tab-row]").length).toBe(2);
  expect(textsOf(host, "[data-tab-row] .tab-name")).toEqual(["migrate-up", "backfill"]);
});

test("the header names the space and is the picker's trigger", async () => {
  const host = await render(<Space spaceId="w1" onBack={() => {}} load={load(TREE)} />);
  const trigger = host.querySelector("[data-space-picker]")!;
  expect(trigger.textContent).toContain("schema-migration");
});

test("add-tab is the last row of the list it adds to, not a floating button", async () => {
  // The capability has to be SET. `spacesAvailable` defaults to false in the
  // store, and the `+` is deliberately gated on it — with no herdr session the
  // create routes 404 honestly, so an ungated control would always error. A
  // test that leaves it false asserts against a screen that correctly offers
  // no create control at all, which is not what this test is about.
  useStore.setState({ spacesAvailable: true });
  const host = await render(<Space spaceId="w1" onBack={() => {}} load={load(TREE)} />);
  const rows = [...host.querySelectorAll("[data-tab-row], [data-create]")];
  expect(rows.at(-1)!.getAttribute("data-create")).toBe("tab");
  expect(rows.at(-1)!.textContent).toContain("New tab");
});

test("the space's own actions are in the header, and the tabs' are on their rows", async () => {
  const host = await render(<Space spaceId="w1" onBack={() => {}} load={load(TREE)} />);
  // One ⋯ in the header for the space, one per tab row. Never the same control
  // in the same place meaning two different scopes.
  expect(host.querySelectorAll(".space-screen-head [aria-label^='Actions']").length).toBe(1);
  expect(host.querySelectorAll("[data-tab-row] [aria-label^='Actions']").length).toBe(2);
});

test("a space id that addresses nothing says so, and never renders an empty list", async () => {
  // An empty tab list is indistinguishable from a real space that has none —
  // the same "an empty screen and a broken herdr must never look alike" rule
  // the failed-read branch follows.
  const host = await render(<Space spaceId="w9" onBack={() => {}} load={load(TREE)} />);
  expect(host.querySelectorAll("[data-tab-row]").length).toBe(0);
  expect(host.textContent).toContain("gone");
  expect(host.querySelector("a[href='#/spaces']")).not.toBeNull();
});

test("a failed read is surfaced, never rendered as a space with no tabs", async () => {
  const host = await render(
    <Space spaceId="w1" onBack={() => {}} load={async () => { throw new Error("herdr socket refused"); }} />,
  );
  expect(host.querySelector("[role='alert']")?.textContent).toContain("herdr socket refused");
  expect(host.textContent).not.toContain("gone");
});

test("back leaves for the list", async () => {
  let backs = 0;
  const host = await render(<Space spaceId="w1" onBack={() => { backs += 1; }} load={load(TREE)} />);
  await click(host.querySelector(".space-screen-head .term-back"));
  expect(backs).toBe(1);
});
