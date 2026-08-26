import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { render, settle, textsOf, unmount } from "./support/render";
import { Spaces } from "@web/components/Spaces";
import { useStore } from "@web/store";
import type { SpaceTree } from "@shared/types";

const load = (t: SpaceTree) => async () => t;

const TABBED: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w3", label: "schema migration", tabCount: 2, paneCount: 2,
    tabs: [
      { tabId: "w3:t1", label: "migrate up", panes: [{ paneId: "w3:p1", harness: "codex", name: "schema-migration", title: "x", cwd: "/srv/project", state: "working" }] },
      { tabId: "w3:t2", label: null, panes: [{ paneId: "w3:p2", harness: "claude", name: "schema-migration-2", title: "x", cwd: "/srv/project", state: "idle" }] },
    ],
  }],
};

afterEach(async () => {
  await unmount();
  useStore.setState({ spacesAvailable: false });
});

test("a failed read is surfaced, never rendered as an empty session", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => { throw new Error("socket refused"); }} />);
  await settle();
  expect(el.textContent).toContain("socket refused");
  expect(el.textContent).not.toContain("No spaces");
  await unmount();
});

test("no row carries a management control — the whole point of the second level", async () => {
  // The regression guard for the measurement this redesign is built on: eleven
  // spaces each carrying a link, a ⋯ and a + put 33 tap targets on one 390px
  // viewport while fitting every row without a scroll. If a control comes back
  // onto a row, this fails.
  // The capability is set deliberately, and this is the whole point of the
  // test. `spacesAvailable` defaults to FALSE, and the create control is gated
  // on it — so with the default this assertion would pass even if every row
  // still rendered a `+`, because nothing would render one either way. Setting
  // it true is what makes this a guard: the rows carry no create control EVEN
  // WHEN creating is available.
  useStore.setState({ spacesAvailable: true });
  const host = await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  const list = host.querySelector(".spaces")!;
  expect(list.querySelectorAll("[data-create]").length).toBe(0);
  expect(list.querySelectorAll("[aria-label^='Actions']").length).toBe(0);
  expect(list.querySelectorAll("button").length).toBe(0);
});

test("a row opens its space, not a pane", async () => {
  const host = await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  expect(host.querySelector("[data-space-row] a")?.getAttribute("href")).toBe("#/space/w3");
});

test("a row says its name, its rollup state and its pane count, and nothing else", async () => {
  const host = await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  const row = host.querySelector("[data-space-row]")!;
  expect(row.querySelector(".space-name")?.textContent).toBe("schema migration");
  expect(row.querySelector(".space-state")?.textContent).toBe("working");
  expect(row.querySelector(".space-count")?.textContent).toBe("2");
  // The alias is gone with the merged row it explained.
  expect(row.querySelector(".space-alias")).toBeNull();
});

test("nothing collapses, so nothing offers to", async () => {
  const host = await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  expect(host.querySelector("[data-expand]")).toBeNull();
  expect(host.querySelector("[aria-expanded]")).toBeNull();
});

test("the collapsed-state key is not written any more", async () => {
  // A stale key holding space ids that address nothing is worse than none.
  localStorage.removeItem("paddock.spaces.collapsed");
  await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  expect(localStorage.getItem("paddock.spaces.collapsed")).toBeNull();
});

test("blocked sorts first and a space with no agent sorts last", async () => {
  const MIXED: SpaceTree = {
    readAt: 1_700_000_000_000,
    spaces: [
      { spaceId: "wi", label: "docs-cleanup", tabCount: 1, paneCount: 1, tabs: [{ tabId: "wi:t1", label: null, panes: [{ paneId: "wi:p1", harness: "claude", name: null, title: "t", cwd: "/srv/project", state: "idle" }] }] },
      { spaceId: "wn", label: "scratch", tabCount: 1, paneCount: 1, tabs: [{ tabId: "wn:t1", label: null, panes: [{ paneId: "wn:p1", harness: null, name: null, title: "t", cwd: "/srv/project", state: null }] }] },
      { spaceId: "wb", label: "flaky-test-fix", tabCount: 1, paneCount: 1, tabs: [{ tabId: "wb:t1", label: null, panes: [{ paneId: "wb:p1", harness: "claude", name: null, title: "t", cwd: "/srv/project", state: "blocked" }] }] },
    ],
  };
  const host = await render(<Spaces onBack={() => {}} load={load(MIXED)} />);
  expect(textsOf(host, "[data-space-row] .space-name")).toEqual(["flaky-test-fix", "docs-cleanup", "scratch"]);
});

test("the header keeps the one control that makes a space", async () => {
  useStore.setState({ spacesAvailable: true });
  const host = await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  expect(host.querySelector(".spaces-head [data-create='space']")).not.toBeNull();
});

test("an unnamed space is named by its id, because a blank row is not a row", async () => {
  const UNNAMED: SpaceTree = {
    readAt: 1_700_000_000_000,
    spaces: [{ spaceId: "w7", label: null, tabCount: 1, paneCount: 1, tabs: [{ tabId: "w7:t1", label: null, panes: [{ paneId: "w7:p1", harness: "claude", name: null, title: "t", cwd: "/srv/project", state: "idle" }] }] }],
  };
  const host = await render(<Spaces onBack={() => {}} load={load(UNNAMED)} />);
  expect(textsOf(host, "[data-space-row] .space-name")).toEqual(["w7"]);
});
