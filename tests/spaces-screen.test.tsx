import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { click, render, settle, textsOf, unmount } from "./support/render";
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
  const el = await render(<Spaces load={async () => { throw new Error("socket refused"); }} />);
  await settle();
  expect(el.textContent).toContain("socket refused");
  expect(el.textContent).not.toContain("No spaces");
  await unmount();
});

test("a row carries its space's ⋯ and NOTHING else — one control, not three", async () => {
  // The regression guard for the measurement this redesign is built on, in its
  // amended form. Eleven spaces each carrying a link, a ⋯ and a + put 33 tap
  // targets on one 390px viewport while fitting every row without a scroll.
  //
  // The ⋯ came back deliberately, on the operator's own report after using the
  // screen: reaching a rename through a drill-down taxed the common case. The
  // `+` did not, and that is the half this test now exists to hold — an
  // eleven-times-repeated control for something done rarely is what turned a
  // list into a control panel.
  //
  // The capability is set deliberately, and it is what makes this a guard.
  // `spacesAvailable` defaults to FALSE and the create control is gated on it,
  // so with the default the `+` assertion would pass even if every row rendered
  // one, because nothing would render one either way.
  useStore.setState({ spacesAvailable: true });
  const host = await render(<Spaces load={load(TABBED)} />);
  const list = host.querySelector(".spaces")!;

  // The half that must stay gone: no create control on any row, even though
  // creating is available.
  expect(list.querySelectorAll("[data-create]").length).toBe(0);

  // The half that came back: exactly one ⋯ per row, and no other button.
  const rows = list.querySelectorAll("[data-space-row]");
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.querySelectorAll("[data-row-actions]").length).toBe(1);
    expect(row.querySelectorAll("button").length).toBe(1);
  }
});

test("the row's ⋯ is scoped to the SPACE, not to a tab or an agent", async () => {
  // A control on the list whose target the list does not show is how this
  // screen became a control panel the first time. The row shows a space, so
  // the sheet offers a space — renaming a tab belongs to #/space/<id>, where
  // the row you tap is the tab you mean.
  useStore.setState({ spacesAvailable: true });
  const host = await render(<Spaces load={load(TABBED)} />);
  const trigger = host.querySelector("[data-space-row] [data-row-actions]") as HTMLElement;
  expect(trigger.getAttribute("aria-label")).toContain("schema migration");
  await click(trigger);
  const sheet = document.querySelector('[data-slot="sheet-content"]')!;
  // On the CONTROLS, not on the prose. The close consequence line legitimately
  // reads "This space, and every tab, pane and agent in it" — closing a space
  // does take its tabs, and saying so is the point of that line. What must not
  // appear is a control that ACTS on a tab.
  const controls = [...sheet.querySelectorAll("button")].map((b) => b.textContent ?? "");
  expect(controls.some((t) => t.includes("Rename space"))).toBe(true);
  expect(controls.some((t) => t.includes("Close space"))).toBe(true);
  expect(controls.some((t) => t.includes("Rename tab") || t.includes("Close tab"))).toBe(false);
});

test("a row opens its space, not a pane", async () => {
  const host = await render(<Spaces load={load(TABBED)} />);
  expect(host.querySelector("[data-space-row] a")?.getAttribute("href")).toBe("#/space/w3");
});

test("a row says its name, its rollup state and its pane count, and nothing else", async () => {
  const host = await render(<Spaces load={load(TABBED)} />);
  const row = host.querySelector("[data-space-row]")!;
  expect(row.querySelector(".space-name")?.textContent).toBe("schema migration");
  expect(row.querySelector(".space-state")?.textContent).toBe("working");
  expect(row.querySelector(".space-count")?.textContent).toBe("2");
  // The alias is gone with the merged row it explained. A tombstone, not a
  // guard: nothing in `src/web/` can produce `.space-alias` any more, so this
  // cannot fail — a real regression here would show up as the row rendering
  // the wrong markup entirely, caught by the assertions above instead.
  expect(row.querySelector(".space-alias")).toBeNull();
});

test("nothing collapses, so nothing offers to", async () => {
  const host = await render(<Spaces load={load(TABBED)} />);
  // A tombstone, not a guard: nothing in `src/web/` can produce
  // `[data-expand]` any more, so this assertion cannot fail.
  expect(host.querySelector("[data-expand]")).toBeNull();
  // Scoped to `.spaces`, not the whole screen: Radix's dialog trigger sets
  // `aria-expanded` on itself, so an unscoped query here would only pass
  // because `spacesAvailable` defaults to false and the header `+` (a Radix
  // sheet trigger) does not render. Scoping makes this assert what its name
  // says — that the LIST offers no expand/collapse — rather than riding on an
  // unrelated control being absent.
  // `:not([data-row-actions])` because the row's ⋯ is a Radix sheet trigger and
  // sets `aria-expanded` on itself. That is a SHEET opening, not a row
  // expanding — the collapse this test guards against was a chevron that
  // revealed sub-rows in place, and nothing on this screen does that any more.
  // Excluding it by its own attribute keeps the query strong; widening it back
  // to "no aria-expanded anywhere" would have made the test unfalsifiable the
  // moment any Radix control landed in the list.
  expect(host.querySelector(".spaces [aria-expanded]:not([data-row-actions])")).toBeNull();
});

test("the collapsed-state key is not written any more", async () => {
  // A stale key holding space ids that address nothing is worse than none.
  localStorage.removeItem("paddock.spaces.collapsed");
  await render(<Spaces load={load(TABBED)} />);
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
  const host = await render(<Spaces load={load(MIXED)} />);
  expect(textsOf(host, "[data-space-row] .space-name")).toEqual(["flaky-test-fix", "docs-cleanup", "scratch"]);

  // The null-state marker `ui/StateMarker.tsx` was hoisted for, on this
  // surface: "scratch" has no agent, so it gets `.dot-none` (never `idle`'s
  // hollow ring) and says "no agent" in words, not just a sort position.
  const rows = [...host.querySelectorAll("[data-space-row]")];
  const noAgentRow = rows.find((r) => r.querySelector(".space-name")?.textContent === "scratch")!;
  expect(noAgentRow.querySelector(".dot-none")).not.toBeNull();
  expect(noAgentRow.querySelector(".space-state")?.textContent).toBe("no agent");
});

test("the header keeps the one control that makes a space", async () => {
  useStore.setState({ spacesAvailable: true });
  const host = await render(<Spaces load={load(TABBED)} />);
  expect(host.querySelector(".spaces-head [data-create='space']")).not.toBeNull();
});

test("an unnamed space is named by its id, because a blank row is not a row", async () => {
  const UNNAMED: SpaceTree = {
    readAt: 1_700_000_000_000,
    spaces: [{ spaceId: "w7", label: null, tabCount: 1, paneCount: 1, tabs: [{ tabId: "w7:t1", label: null, panes: [{ paneId: "w7:p1", harness: "claude", name: null, title: "t", cwd: "/srv/project", state: "idle" }] }] }],
  };
  const host = await render(<Spaces load={load(UNNAMED)} />);
  expect(textsOf(host, "[data-space-row] .space-name")).toEqual(["w7"]);
});

test("a fresh read shows the glyph alone; an old one says how old", async () => {
  // The screen is on demand, and the original rule stands: an implied-live one
  // would be a guess rendered as a fact. But it re-reads on every write and on
  // `tree-stale`, so the age sat at "as of 0s ago" all day — announcing a
  // staleness that was not there, beside the title. Under the threshold the
  // control is the glyph alone; past it the age appears, because then it is
  // news. The `aria-label` carries the number at every age.
  const fresh = await render(
    <Spaces load={async () => ({ spaces: [], readAt: Date.now() })} />,
  );
  await settle();
  expect(fresh.querySelector(".spaces-refresh")?.textContent?.trim()).toBe("⟳");
  expect(fresh.querySelector(".spaces-refresh")?.getAttribute("aria-label"))
    .toContain("0s ago");
  await unmount();

  const old = await render(
    <Spaces load={async () => ({ spaces: [], readAt: Date.now() - 60_000 })} />,
  );
  await settle();
  const text = old.querySelector(".spaces-refresh")?.textContent ?? "";
  expect(text).toContain("as of");
  expect(text).toContain("60s ago");
});
