import "./support/dom";
import { expect, test } from "bun:test";
import { click, render, settle, typeInto, unmount } from "./support/render";
import { RequestFailed } from "@web/api";
import { paneLabel } from "@web/components/pane-label";
import type { RowSenders } from "@web/components/RowActions";
import { Spaces } from "@web/components/Spaces";
import type { SpaceTree } from "@shared/types";

/*
 * The row actions sheet: the `⋯` and what it opens.
 *
 * Every fixture here uses invented names and `/srv/project` paths — the public
 * repo rule, and the one most likely to be broken by accident in a fixture.
 */

/** The commonest space shape — one tab, one pane, one working agent. */
const FLAT: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w1", label: "api-refactor", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w1:t1", label: null, panes: [
      { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "api-refactor", cwd: "/srv/project", state: "working" },
    ] }],
  }],
};

/** Two tabs, so the space row and the pane sub-rows are separate rows. */
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

/** A merged row whose pane has NO agent: the case where the row shows the
 *  space label and the pane's own identity, and the `⋯` has to announce both. */
const SHELL: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w3", label: "docs-cleanup", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w3:t1", label: null, panes: [
      { paneId: "w3:p1", harness: null, name: null, title: "bash", cwd: "/srv/project/scratch", state: null },
    ] }],
  }],
};

/** One tab holding two panes (`pane.split`): a working agent and a shell.
 *  Closing that tab kills one agent, not two — the count has to say so. */
const SPLIT: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w4", label: "flaky-test-fix", tabCount: 1, paneCount: 2,
    tabs: [{ tabId: "w4:t1", label: "run-it-again", panes: [
      { paneId: "w4:p1", harness: "claude", name: "flaky-test-fix", title: "t", cwd: "/srv/project", state: "working" },
      { paneId: "w4:p2", harness: null, name: null, title: "bash", cwd: "/srv/project", state: null },
    ] }],
  }],
};

/** Records every write instead of performing one, so nothing here needs a
 *  network. Individual senders are overridable to make one of them fail. */
function recorder(over: Partial<RowSenders> = {}) {
  const calls: string[] = [];
  const senders: RowSenders = {
    renameAgent: async (id, name) => { calls.push(`renameAgent ${id} ${JSON.stringify(name)}`); return { ok: true }; },
    renameTab: async (id, label) => { calls.push(`renameTab ${id} ${label}`); return { ok: true }; },
    renameSpace: async (id, label) => { calls.push(`renameSpace ${id} ${label}`); return { ok: true }; },
    closeTab: async (id) => { calls.push(`closeTab ${id}`); return { ok: true }; },
    closeSpace: async (id) => { calls.push(`closeSpace ${id}`); return { ok: true }; },
    ...over,
  };
  return { calls, senders };
}

/** Counts reads, so "the tree is refetched" is an assertion rather than a hope. */
function counted(tree: SpaceTree) {
  const state = { loads: 0 };
  return { state, load: async () => { state.loads += 1; return tree; } };
}

/** The sheet is PORTALLED — it is not inside the host `render` returns. */
function sheet(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-slot="sheet-content"]');
  if (!el) throw new Error("no sheet is open");
  return el;
}

/** A button in the open sheet, by its visible text. Throws rather than
 *  returning null: a selector that stops matching must fail its test, not
 *  assert against an untouched component. */
function sheetButton(text: string): HTMLButtonElement {
  const found = [...sheet().querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").includes(text));
  if (!found) throw new Error(`no sheet button containing "${text}"`);
  return found as HTMLButtonElement;
}

function triggers(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>("[data-row-actions]")];
}

test("every row carries a ⋯ that is visible and ENABLED, not an inert promise", async () => {
  // The predecessor of this control shipped permanently `disabled`, announcing
  // an action it could not perform, and was removed for it. And it is a
  // BUTTON on the row, not an unhinted long-press: §6.1 names that as the
  // touch equivalent of a hover-only affordance.
  const merged = await render(<Spaces onBack={() => {}} load={async () => FLAT} senders={recorder().senders} />);
  await settle();
  expect(triggers(merged)).toHaveLength(1);
  expect(triggers(merged)[0]!.disabled).toBe(false);
  expect(triggers(merged)[0]!.textContent).toContain("⋯");
  await unmount();

  // A structured space: one for the space, one for each pane sub-row.
  const structured = await render(<Spaces onBack={() => {}} load={async () => STRUCTURED} senders={recorder().senders} />);
  await settle();
  expect(triggers(structured)).toHaveLength(3);
  for (const t of triggers(structured)) expect(t.disabled).toBe(false);
  await unmount();
});

test("the ⋯ announces the row's full visible label, on a space row and a pane row", async () => {
  // The removed version diverged from the row it sat on: a shell row read
  // `bash` while its button announced `w3:p1`. `paneLabel` is the one home for
  // that expression (§16.6), so the test asserts against the helper rather
  // than against a string spelled a second time here.
  const el = await render(<Spaces onBack={() => {}} load={async () => STRUCTURED} senders={recorder().senders} />);
  await settle();

  const spaceTrigger = el.querySelector<HTMLButtonElement>(".space-head [data-row-actions]")!;
  const visibleSpace = el.querySelector(".space-name")!.textContent!;
  expect(spaceTrigger.getAttribute("aria-label")).toContain(visibleSpace);

  const paneTriggers = [...el.querySelectorAll<HTMLButtonElement>(".space-tabs [data-row-actions]")];
  const panes = STRUCTURED.spaces[0]!.tabs.flatMap((t) => t.panes);
  expect(paneTriggers).toHaveLength(panes.length);
  paneTriggers.forEach((t, i) => {
    expect(t.getAttribute("aria-label")).toContain(paneLabel(panes[i]!));
  });
  await unmount();
});

test("a merged row's ⋯ announces the alias too, because the row shows it", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => SHELL} senders={recorder().senders} />);
  await settle();
  const label = triggers(el)[0]!.getAttribute("aria-label")!;
  expect(label).toContain("docs-cleanup");
  expect(label).toContain(paneLabel(SHELL.spaces[0]!.tabs[0]!.panes[0]!));
  await unmount();
});

test("the sheet offers rename and close", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => FLAT} senders={recorder().senders} />);
  await settle();
  await click(triggers(el)[0]);
  expect(sheet().textContent).toContain("Rename space");
  expect(sheet().textContent).toContain("Close space");
  await unmount();
});

test("a pane row reaches its agent and the tab that holds it", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => STRUCTURED} senders={recorder().senders} />);
  await settle();
  await click(el.querySelector(".space-tabs [data-row-actions]"));
  expect(sheet().textContent).toContain("Rename agent");
  expect(sheet().textContent).toContain("Rename tab");
  expect(sheet().textContent).toContain("Close tab");
  await unmount();
});

test("a shell pane offers no agent rename — there is no agent to rename", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => SPLIT} senders={recorder().senders} />);
  await settle();
  const paneTriggers = [...el.querySelectorAll<HTMLButtonElement>(".space-tabs [data-row-actions]")];
  await click(paneTriggers[1]); // the shell half of the split
  expect(sheet().textContent).not.toContain("Rename agent");
  expect(sheet().textContent).toContain("Rename tab");
  await unmount();
});

test("a rename submits the typed label, and the tree is re-read afterwards", async () => {
  const { state, load } = counted(STRUCTURED);
  const { calls, senders } = recorder();
  const el = await render(<Spaces onBack={() => {}} load={load} senders={senders} />);
  await settle();
  const before = state.loads;

  await click(el.querySelector(".space-tabs [data-row-actions]"));
  await click(sheetButton("Rename agent"));
  await typeInto(sheet().querySelector("input")!, "api-refactor-2");
  await click(sheetButton("Save"));
  await settle();

  expect(calls).toEqual(["renameAgent w2:p1 \"api-refactor-2\""]);
  // No optimistic update: the screen shows what herdr holds, so a success is
  // followed by a read.
  expect(state.loads).toBeGreaterThan(before);
  await unmount();
});

test("a space rename targets the space, not its pane", async () => {
  const { calls, senders } = recorder();
  const el = await render(<Spaces onBack={() => {}} load={async () => FLAT} senders={senders} />);
  await settle();
  await click(triggers(el)[0]);
  await click(sheetButton("Rename space"));
  await typeInto(sheet().querySelector("input")!, "auth-work");
  await click(sheetButton("Save"));
  await settle();
  expect(calls).toEqual(["renameSpace w1 auth-work"]);
  await unmount();
});

test("an empty label cannot be submitted for a tab", async () => {
  // §17: herdr ACCEPTS an empty label and stores the empty string — it is not
  // a clear. The route refuses it with a 400, and a control that lets you
  // submit something guaranteed to fail is a bad control.
  const { calls, senders } = recorder();
  const el = await render(<Spaces onBack={() => {}} load={async () => STRUCTURED} senders={senders} />);
  await settle();
  await click(el.querySelector(".space-tabs [data-row-actions]"));
  await click(sheetButton("Rename tab"));
  await typeInto(sheet().querySelector("input")!, "");
  const save = sheetButton("Save");
  expect(save.disabled).toBe(true);
  await click(save);
  await settle();
  expect(calls).toEqual([]);
  await unmount();
});

test("a whitespace-only label cannot be submitted for a space either", async () => {
  const { calls, senders } = recorder();
  const el = await render(<Spaces onBack={() => {}} load={async () => FLAT} senders={senders} />);
  await settle();
  await click(triggers(el)[0]);
  await click(sheetButton("Rename space"));
  await typeInto(sheet().querySelector("input")!, "   ");
  expect(sheetButton("Save").disabled).toBe(true);
  await click(sheetButton("Save"));
  await settle();
  expect(calls).toEqual([]);
  await unmount();
});

test("the agent's clear says what clearing does, and never calls it a reset", async () => {
  // Clearing does not restore a herdr-derived name — herdr does not re-derive
  // one — so the agent lands on paddock's own basename(cwd) fallback, which is
  // a DIFFERENT label (§7.2).
  const { calls, senders } = recorder();
  const el = await render(<Spaces onBack={() => {}} load={async () => FLAT} senders={senders} />);
  await settle();
  await click(triggers(el)[0]);
  const text = sheet().textContent ?? "";
  expect(text).toContain("Clear name");
  expect(text).toContain("folder");
  expect(text.toLowerCase()).not.toContain("reset");
  expect(text.toLowerCase()).not.toContain("default");

  await click(sheetButton("Clear name"));
  await settle();
  expect(calls).toEqual(["renameAgent w1:p1 null"]);
  await unmount();
});

test("a tab or a space is offered no clear at all", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => STRUCTURED} senders={recorder().senders} />);
  await settle();
  // The space row: its only rename target is the space.
  await click(el.querySelector(".space-head [data-row-actions]"));
  expect(sheet().textContent).not.toContain("Clear");
  await unmount();
});

test("close is arm-then-confirm, and the confirmation states the consequence", async () => {
  const { calls, senders } = recorder();
  const el = await render(<Spaces onBack={() => {}} load={async () => FLAT} senders={senders} />);
  await settle();
  await click(triggers(el)[0]);

  // Nothing is armed on open: the consequence is not on screen yet.
  expect(sheet().textContent).not.toContain("will be killed");

  await click(sheetButton("Close space"));
  // Armed. It states what dies, not "tap again".
  expect(sheet().textContent).toContain("1 working agent will be killed.");
  expect(calls).toEqual([]);

  // The second tap.
  await click(sheetButton("Close space"));
  await settle();
  expect(calls).toEqual(["closeSpace w1"]);
  await unmount();
});

test("the consequence count comes off the tree on screen, and counts agents not panes", async () => {
  // The split tab holds a working agent and a shell. Closing it kills one
  // agent; saying "2" would be counting panes.
  const { senders } = recorder();
  const el = await render(<Spaces onBack={() => {}} load={async () => SPLIT} senders={senders} />);
  await settle();
  await click(el.querySelector(".space-tabs [data-row-actions]"));
  await click(sheetButton("Close tab"));
  expect(sheet().textContent).toContain("1 working agent will be killed.");
  await unmount();
});

test("a close with no agent in it says what actually happens", async () => {
  const { senders } = recorder();
  const el = await render(<Spaces onBack={() => {}} load={async () => SHELL} senders={senders} />);
  await settle();
  await click(triggers(el)[0]);
  await click(sheetButton("Close space"));
  expect(sheet().textContent).toContain("1 pane will close, no agent running.");
  await unmount();
});

test("the last space's close is NOT disabled — herdr's policy is unmeasured", async () => {
  // §17 probe 3: whether herdr permits closing the last space cannot be
  // measured on a live herd, so paddock surfaces herdr's refusal instead of
  // predicting it. A disabled button here would encode a guess as a fact.
  const { calls, senders } = recorder({
    closeSpace: async (id) => {
      calls.push(`closeSpace ${id}`);
      throw new RequestFailed(502, "herdr: cannot close the last workspace");
    },
  });
  const { state, load } = counted(FLAT);
  const el = await render(<Spaces onBack={() => {}} load={load} senders={senders} />);
  await settle();
  expect(FLAT.spaces).toHaveLength(1);

  await click(triggers(el)[0]);
  await click(sheetButton("Close space"));
  const confirm = sheetButton("Close space");
  expect(confirm.disabled).toBe(false);

  const before = state.loads;
  await click(confirm);
  await settle();
  // The refusal is on screen, verbatim, and the tree was re-read so the
  // screen shows what herdr holds rather than what was asked for.
  expect(sheet().textContent).toContain("cannot close the last workspace");
  expect(state.loads).toBeGreaterThan(before);
  await unmount();
});

test("a failed rename is surfaced with the server's own detail", async () => {
  const { senders } = recorder({
    renameSpace: async () => { throw new RequestFailed(400, "label must not be empty"); },
  });
  const el = await render(<Spaces onBack={() => {}} load={async () => FLAT} senders={senders} />);
  await settle();
  await click(triggers(el)[0]);
  await click(sheetButton("Rename space"));
  await typeInto(sheet().querySelector("input")!, "auth-work");
  await click(sheetButton("Save"));
  await settle();
  // Still open, carrying the reason — never a silent failure.
  expect(sheet().querySelector('[role="alert"]')?.textContent).toContain("label must not be empty");
  await unmount();
});

test("a successful write closes the sheet", async () => {
  const { senders } = recorder();
  const el = await render(<Spaces onBack={() => {}} load={async () => FLAT} senders={senders} />);
  await settle();
  await click(triggers(el)[0]);
  await click(sheetButton("Close space"));
  await click(sheetButton("Close space"));
  await settle();
  expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
  await unmount();
});
