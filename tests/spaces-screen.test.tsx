import "./support/dom";
import { expect, test } from "bun:test";
import { render, settle, unmount } from "./support/render";
import { Spaces } from "@web/components/Spaces";
import type { SpaceTree } from "@shared/types";

const FLAT: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w1", label: "api-refactor", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w1:t1", label: null, panes: [
      { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "api-refactor", cwd: "/srv/project", state: "working" },
    ] }],
  }],
};

const STRUCTURED: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w2", label: "schema-migration", tabCount: 2, paneCount: 2,
    tabs: [
      { tabId: "w2:t1", label: "migrate-up", panes: [{ paneId: "w2:p1", harness: "codex", name: "schema-migration", title: "m", cwd: "/srv/project", state: "working" }] },
      { tabId: "w2:t2", label: null, panes: [{ paneId: "w2:p2", harness: "claude", name: "schema-migration-2", title: "b", cwd: "/srv/project", state: "idle" }] },
    ],
  }],
};

const SHELL: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w3", label: "docs-cleanup", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w3:t1", label: null, panes: [
      // cwd's own last segment is "bash", not `/srv/project` like the other
      // fixtures: the shell defect fix (§16.6) labels a pane with no agent by
      // its folder, never by its terminal title, so the pinned assertions
      // below that expect "bash" on screen need the folder itself to be the
      // thing named that.
      { paneId: "w3:p1", harness: null, name: null, title: "bash", cwd: "/srv/project/bash", state: null },
    ] }],
  }],
};

// One tab, two panes — `pane.split`. Structured, and NOT because of its tabs:
// the row's count has to explain the sub-rows under it.
const SPLIT: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w4", label: "flaky-test-fix", tabCount: 1, paneCount: 2,
    tabs: [{ tabId: "w4:t1", label: null, panes: [
      { paneId: "w4:p1", harness: "claude", name: "flaky-test-fix", title: "t", cwd: "/srv/project", state: "working" },
      { paneId: "w4:p2", harness: null, name: null, title: "bash", cwd: "/srv/project", state: null },
    ] }],
  }],
};

const load = (t: SpaceTree) => async () => t;

const SLUG: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w1", label: "api refactor", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w1:t1", label: null, panes: [
      { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "x", cwd: "/srv/project", state: "idle" },
    ] }],
  }],
};

const DIVERGED: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w2", label: "api refactor", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w2:t1", label: null, panes: [
      { paneId: "w2:p1", harness: "claude", name: "chasing a flaky test", title: "x", cwd: "/srv/project", state: "idle" },
    ] }],
  }],
};

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

const SHELL_HOME: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w4", label: "scratch", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w4:t1", label: null, panes: [
      { paneId: "w4:p1", harness: null, name: null, title: "operator@dev-box:~", cwd: "~", state: null },
    ] }],
  }],
};

test("a name that is the slug of its space label shows no alias", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => SLUG} />);
  await settle();
  expect(el.textContent).toContain("api refactor");
  expect(el.querySelector(".space-alias")).toBeNull();
  await unmount();
});

test("a genuinely different name is shown, on the pane not the space", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => DIVERGED} />);
  await settle();
  expect(el.textContent).toContain("api refactor");
  expect(el.textContent).toContain("chasing a flaky test");
  await unmount();
});

test("a tab label is a caption on its pane, not a heading above a group", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => TABBED} />);
  await settle();
  expect(el.querySelector("h3")).toBeNull();
  const cap = el.querySelector(".pane-tab");
  expect(cap?.textContent).toContain("migrate up");
  // The pane it captions, not a sibling of the group.
  expect(cap?.closest("[data-pane-row]")).not.toBeNull();
  await unmount();
});

test("an unnamed tab contributes no caption at all", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => TABBED} />);
  await settle();
  expect(el.querySelectorAll(".pane-tab")).toHaveLength(1);
  await unmount();
});

test("a shell is labelled by its folder, never by its prompt", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => SHELL_HOME} />);
  await settle();
  const row = el.querySelector("[data-pane-row]")!;
  expect(row.textContent).not.toContain("operator@dev-box");
  expect(row.textContent).toContain("~");
  await unmount();
});

test("a 1:1:1 space renders as ONE row with nothing to expand", async () => {
  const el = await render(<Spaces onBack={() => {}} load={load(FLAT)} />);
  await settle();
  expect(el.textContent).toContain("api-refactor");
  expect(el.querySelectorAll("[data-space-row]")).toHaveLength(1);
  expect(el.querySelector("[data-expand]")).toBeNull();
  await unmount();
});

test("a space with two tabs renders sub-rows", async () => {
  const el = await render(<Spaces onBack={() => {}} load={load(STRUCTURED)} />);
  await settle();
  expect(el.querySelectorAll("[data-pane-row]")).toHaveLength(2);
  expect(el.textContent).toContain("migrate-up");
  await unmount();
});

test("a pane with no agent is shown, and never labelled with a state", async () => {
  const el = await render(<Spaces onBack={() => {}} load={load(SHELL)} />);
  await settle();
  const row = el.querySelector("[data-pane-row]")!;
  expect(row.textContent).toContain("bash");
  expect(row.textContent).not.toContain("idle");
  expect(row.getAttribute("data-state")).toBe("none");
  await unmount();
});

test("a failed read is surfaced, never rendered as an empty session", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => { throw new Error("socket refused"); }} />);
  await settle();
  expect(el.textContent).toContain("socket refused");
  expect(el.textContent).not.toContain("No spaces");
  await unmount();
});

test("a merged row is a link into the pane", async () => {
  // The commonest space shape — six in seven are 1:1:1 — used to render no
  // anchor at all, so the only route into a shell's terminal was typing its
  // hash by hand. A structured space's sub-rows had carried the same link
  // since Task 11, which is what made the omission easy to miss.
  const el = await render(<Spaces onBack={() => {}} load={load(SHELL)} />);
  await settle();

  const link = el.querySelector<HTMLAnchorElement>("[data-space-row][data-pane-row] a[href]");
  expect(link).not.toBeNull();
  // The pane id, encoded — the colon in `w3:p1` is not a literal in a hash.
  expect(link!.getAttribute("href")).toBe("#/pane/w3%3Ap1");
  // The label the operator reads is INSIDE the target they tap.
  expect(link!.textContent).toContain("bash");
  await unmount();
});

test("no row announces an action that does not exist yet", async () => {
  // Every row used to carry a `disabled` ⋯ labelled "Actions for X". A
  // control that announces an action and cannot perform it is a mislabelled
  // control, which CLAUDE.md rates worse than no control. The affordance
  // comes back WITH the sheet — see the note at the top of SpaceRow.tsx —
  // and this is what fails if it comes back inert instead.
  for (const tree of [FLAT, STRUCTURED, SHELL]) {
    const el = await render(<Spaces onBack={() => {}} load={load(tree)} />);
    await settle();
    expect(el.textContent).not.toContain("⋯");
    expect(el.querySelectorAll("button[disabled]")).toHaveLength(0);
    await unmount();
  }
});

test("a structured space says the count that explains its shape, and says it grammatically", async () => {
  // "1 tabs" was wrong twice: wrong grammar, and the wrong unit for a space
  // that is structured because ONE tab holds several panes — an ordinary
  // result of `pane.split`.
  const el = await render(<Spaces onBack={() => {}} load={load(STRUCTURED)} />);
  await settle();
  expect(el.querySelector(".space-count")!.textContent).toBe("2 tabs");
  await unmount();

  const split = await render(<Spaces onBack={() => {}} load={load(SPLIT)} />);
  await settle();
  expect(split.querySelector(".space-count")!.textContent).toBe("2 panes");
  expect(split.textContent).not.toContain("1 tabs");
  await unmount();
});

test("an agent's merged row opens the same way a shell's does", async () => {
  // One pane at two moments: whether the row's pane has a harness changes what
  // the terminal renders, never whether the row is openable.
  const el = await render(<Spaces onBack={() => {}} load={load(FLAT)} />);
  await settle();
  const link = el.querySelector<HTMLAnchorElement>("[data-space-row][data-pane-row] a[href]");
  expect(link?.getAttribute("href")).toBe("#/pane/w1%3Ap1");
  await unmount();
});

test("a structured space's own row is not a link — there is no single pane to open", async () => {
  // Its panes each carry their own link below; a row-level one would have to
  // pick a pane, and picking one is a guess.
  const el = await render(<Spaces onBack={() => {}} load={load(STRUCTURED)} />);
  await settle();
  const head = el.querySelector("[data-space-row] .space-head")!;
  expect(head.querySelector("a")).toBeNull();
  // The sub-rows still have theirs.
  expect(el.querySelectorAll(".space-tabs [data-pane-row] a[href]")).toHaveLength(2);
  await unmount();
});
