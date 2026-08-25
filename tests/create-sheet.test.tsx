import "./support/dom";
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { click, fire, render, settle, typeInto, unmount } from "./support/render";
import { paneHash } from "@shared/route";
import { RequestFailed } from "@web/api";
import { CreateSheet, slug, type CreateSenders } from "@web/components/CreateSheet";
import { LaunchNotice } from "@web/components/LaunchNotice";
import { Spaces } from "@web/components/Spaces";
import { useLaunch } from "@web/launch";
import { useStore } from "@web/store";
import type { SpaceTree } from "@shared/types";

/*
 * The two `+` controls and the sheet they open.
 *
 * Every fixture here uses invented names and `/srv/...` paths — the public repo
 * rule, and the one most likely to be broken by accident in a fixture.
 */

/**
 * Two spaces, so the row `+` has more than one row to be on and the quick
 * picks have more than one folder to offer.
 *
 * The first space's label deliberately contains a SPACE: the name field
 * pre-fills with the slug of it (§14.7), so a fixture whose label is already a
 * slug would pass whether the slugging happened or not.
 */
const TREE: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [
    {
      spaceId: "w1", label: "api refactor", tabCount: 1, paneCount: 1,
      tabs: [{ tabId: "w1:t1", label: null, panes: [
        { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "x", cwd: "/srv/project", state: "working" },
      ] }],
    },
    {
      spaceId: "w2", label: "docs-cleanup", tabCount: 1, paneCount: 1,
      tabs: [{ tabId: "w2:t1", label: null, panes: [
        { paneId: "w2:p1", harness: null, name: null, title: "bash", cwd: "/srv/docs", state: null },
      ] }],
    },
  ],
};

const KINDS = ["claude", "codex", "aider"];

/** Records every write instead of performing one, so nothing here needs a
 *  network. Individual senders are overridable to make one of them fail. */
function recorder(over: Partial<CreateSenders> = {}) {
  const calls: string[] = [];
  const senders: CreateSenders = {
    harnesses: async () => { calls.push("harnesses"); return KINDS; },
    createSpace: async (opts) => {
      calls.push(`createSpace ${JSON.stringify(opts)}`);
      return { ok: true, spaceId: "w9", tabId: "w9:t1", paneId: "w9:p1" };
    },
    createTab: async (spaceId, opts) => {
      calls.push(`createTab ${spaceId} ${JSON.stringify(opts)}`);
      return { ok: true, tabId: `${spaceId}:t9`, paneId: `${spaceId}:p9` };
    },
    startAgent: async (paneId, kind, name) => {
      calls.push(`startAgent ${paneId} ${kind} ${name}`);
      return { ok: true, paneId };
    },
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

function field(name: string): HTMLInputElement {
  const el = sheet().querySelector<HTMLInputElement>(`input[data-field="${name}"]`);
  if (!el) throw new Error(`no "${name}" field in the sheet`);
  return el;
}

function picker(): HTMLSelectElement {
  const el = sheet().querySelector<HTMLSelectElement>('select[data-field="kind"]');
  if (!el) throw new Error("no harness picker in the sheet");
  return el;
}

function submitButton(): HTMLButtonElement {
  const el = sheet().querySelector<HTMLButtonElement>("button[data-create-submit]");
  if (!el) throw new Error("no submit button in the sheet");
  return el;
}

/**
 * Pick a `<select>` option the way a person does.
 *
 * A bare `change` event, unlike `typeInto`'s three: React's change plugin takes
 * a different branch for `select` than for `input` (see `support/render`), and
 * this is the branch the existing theme test already relies on. Wrapped in
 * `fire` so the dispatch — not the settling after it — is inside `act`.
 */
async function choose(value: string): Promise<void> {
  const sel = picker();
  sel.value = value;
  await fire(sel, new Event("change", { bubbles: true }));
}

/** The screen, with the tree-reading capability the `+` is gated on. */
function withTree(available: boolean) {
  useStore.setState({ spacesAvailable: available });
}

afterEach(() => {
  // Module state, and `bun test` shares a module registry across files: a
  // launch or a capability left set here would leak into another file's
  // expectations.
  useLaunch.setState({ launch: null });
  useStore.setState({ spacesAvailable: false });
});

test("a + sits in the Spaces header and one on every space row", async () => {
  // §16.7: position carries the scope, which is the whole reason neither
  // control needs a text label. So what is pinned is WHERE they are, not just
  // that they exist.
  withTree(true);
  const { senders } = recorder();
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();

  const header = el.querySelector<HTMLButtonElement>('.spaces-head [data-create="space"]');
  expect(header).not.toBeNull();
  expect(header!.disabled).toBe(false);
  expect(header!.textContent).toContain("+");

  const rows = [...el.querySelectorAll<HTMLButtonElement>('[data-space-row] [data-create="tab"]')];
  expect(rows).toHaveLength(TREE.spaces.length);
  for (const r of rows) {
    expect(r.disabled).toBe(false);
    expect(r.textContent).toContain("+");
  }
  // Position is not an accessible name, so the name says the scope in words.
  expect(header!.getAttribute("aria-label")).toBe("New space");
  expect(rows[0]!.getAttribute("aria-label")).toBe("New tab in api refactor");
  await unmount();
});

test("neither + exists when the server does not say it can read a tree", async () => {
  // The same capability the Spaces entry point in App.tsx is gated on. A
  // control that always errors is worse than none — `routes.ts` records that
  // on `/ack`'s Dismiss button — and the gate is a CAPABILITY, never a demo
  // flag, a hostname or a device check.
  withTree(false);
  const { senders, calls } = recorder();
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  expect(el.querySelectorAll("[data-create]")).toHaveLength(0);
  // And nothing was read on the operator's behalf either.
  expect(calls).toEqual([]);
  // The rest of the screen is untouched: the rows and their `⋯` are still here.
  expect(el.querySelectorAll("[data-space-row]")).toHaveLength(2);
  expect(el.querySelectorAll("[data-row-actions]").length).toBeGreaterThan(0);
  await unmount();
});

test("the + is a full touch target, not Collie's 36px", () => {
  // happy-dom implements no layout, so this reads the rule out of the
  // stylesheet — the approach tests/ui-styles.test.ts already takes. It cannot
  // prove the pixels; it does stop the declaration being deleted by someone who
  // does not know §16.7 corrected the size on purpose.
  const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const body = /\.create-btn\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(body).toContain("min-height: 2.75rem");
  expect(body).toContain("min-width: 2.75rem");
});

test("the picker offers the installed harnesses AND a plain shell", async () => {
  // The kinds come from `GET /api/harnesses` and are never hardcoded (§9.3):
  // `kind` is a plain string in protocol 20, so the only defensible allowlist
  // is what the machine actually has installed. The plain shell is wanted too —
  // a shell is genuinely usable now that §16.3 gave it input.
  withTree(true);
  const { senders, calls } = recorder();
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  await click(el.querySelector('.spaces-head [data-create="space"]'));
  await settle();

  const options = [...picker().querySelectorAll("option")];
  expect(options.map((o) => o.value)).toEqual(["", ...KINDS]);
  expect(options[0]!.textContent).toContain("plain shell");
  // The plain shell is the DEFAULT: starting a harness spends real tokens, so
  // it is asked for rather than assumed.
  expect(picker().value).toBe("");
  expect(calls).toContain("harnesses");
  await unmount();
});

test("a failed harness read is surfaced, and the shell option survives it", async () => {
  withTree(true);
  const { senders } = recorder({
    harnesses: async () => { throw new RequestFailed(502, "herdr said no"); },
  });
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  await click(el.querySelector('.spaces-head [data-create="space"]'));
  await settle();
  expect(sheet().textContent).toContain("herdr said no");
  // Never a hardcoded fallback list: what paddock still knows is that a pane
  // with no agent is a thing it can make.
  expect([...picker().querySelectorAll("option")].map((o) => o.value)).toEqual([""]);
  await unmount();
});

test("a new tab's agent name is pre-filled from its space's label, slugified, and is editable", async () => {
  // §14.7: herdr initialises an agent's name to the slug of its workspace
  // label, so this is herdr's own convention rather than paddock's invention.
  // It is deliberately NOT the harness kind — that default was implemented,
  // reviewed and reversed, because every spawn would then have been `claude`,
  // `claude 2`, `claude 3`.
  withTree(true);
  const { senders } = recorder();
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  await click(el.querySelector('[data-space-row] [data-create="tab"]'));
  await settle();
  await choose("claude");

  expect(field("name").value).toBe(slug("api refactor"));
  expect(field("name").value).toBe("api-refactor");
  expect(field("name").value).not.toBe("claude");

  await typeInto(field("name"), "second-pass");
  expect(field("name").value).toBe("second-pass");
  await unmount();
});

test("a new space's agent name tracks the label as it is typed", async () => {
  withTree(true);
  const { senders } = recorder();
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  await click(el.querySelector('.spaces-head [data-create="space"]'));
  await settle();
  await choose("codex");
  await typeInto(field("label"), "flaky test fix");
  expect(field("name").value).toBe("flaky-test-fix");
  await unmount();
});

test("a harness with an emptied name cannot be submitted", async () => {
  // `POST /api/panes/:id/agent` refuses an absent, empty or whitespace-only
  // name with 400. A control that lets you send a request guaranteed to fail is
  // a bad control — the same reasoning as Save on an empty rename label.
  withTree(true);
  const { senders, calls } = recorder();
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  await click(el.querySelector('[data-space-row] [data-create="tab"]'));
  await settle();
  await choose("claude");
  expect(submitButton().disabled).toBe(false);

  await typeInto(field("name"), "");
  expect(submitButton().disabled).toBe(true);
  // Whitespace is not a name either.
  await typeInto(field("name"), "   ");
  expect(submitButton().disabled).toBe(true);

  await click(submitButton());
  expect(calls.filter((c) => c.startsWith("createTab"))).toEqual([]);
  await unmount();
});

test("a plain shell needs no name — there is no agent to name", async () => {
  withTree(true);
  const { senders } = recorder();
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  await click(el.querySelector('[data-space-row] [data-create="tab"]'));
  await settle();
  expect(sheet().querySelector('input[data-field="name"]')).toBeNull();
  expect(submitButton().disabled).toBe(false);
  await unmount();
});

test("cwd defaults to the space's, and every folder in the tree is a quick pick", async () => {
  // §9.3. The snapshot already carries every pane's cwd, so the picks are free,
  // and they are the whole improvement over asking someone to type a filesystem
  // path on a phone keyboard. No directory browsing: that needs a
  // filesystem-listing endpoint, which is its own security surface.
  withTree(true);
  const { senders } = recorder();
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  await click(el.querySelector('[data-space-row] [data-create="tab"]'));
  await settle();

  expect(field("cwd").value).toBe("/srv/project");
  const picks = [...sheet().querySelectorAll<HTMLButtonElement>("[data-cwd-pick]")];
  // Every folder in the WHOLE tree, not only this space's — the operator may
  // be opening a tab for a sibling project.
  expect(picks.map((p) => p.getAttribute("data-cwd-pick"))).toEqual(["/srv/docs", "/srv/project"]);
  await click(picks[0]);
  expect(field("cwd").value).toBe("/srv/docs");
  await unmount();
});

test("a new space's cwd starts empty, so herdr picks its own default", async () => {
  // There is no space to inherit from, and a guessed path is worse than none.
  withTree(true);
  const { senders, calls } = recorder();
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  await click(el.querySelector('.spaces-head [data-create="space"]'));
  await settle();
  expect(field("cwd").value).toBe("");
  await click(submitButton());
  await settle();
  // Neither field is forwarded as an empty string: absent means "herdr's
  // default", which is not the same request as `cwd: ""`.
  expect(calls).toContain("createSpace {}");
  await unmount();
});

test("creating a shell tab navigates to the new pane and refetches, with no agent started", async () => {
  withTree(true);
  const { senders, calls } = recorder();
  const { state, load } = counted(TREE);
  const nav: string[] = [];
  const el = await render(
    <Spaces onBack={() => {}} load={load} createSenders={senders} navigate={(h) => nav.push(h)} />,
  );
  await settle();
  const before = state.loads;
  await click(el.querySelector('[data-space-row] [data-create="tab"]'));
  await settle();
  await typeInto(field("label"), "run-it-again");
  await click(submitButton());
  await settle();

  expect(calls).toContain('createTab w1 {"label":"run-it-again","cwd":"/srv/project"}');
  expect(calls.filter((c) => c.startsWith("startAgent"))).toEqual([]);
  // No optimistic update (§11) — the tree is re-read.
  expect(state.loads).toBeGreaterThan(before);
  expect(nav).toEqual([paneHash("w1:p9")]);
  expect(useLaunch.getState().launch).toBeNull();
  await unmount();
});

test("creating a tab with a harness navigates first, then starts the agent", async () => {
  // §9.2's two steps, in that order and for that reason: the shell exists and
  // renders (§8), so the operator lands on the tab they just made instead of
  // watching a spinner while `agent.start` blocks for up to 30 s.
  withTree(true);
  const { senders, calls } = recorder();
  const nav: string[] = [];
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={(h) => nav.push(h)} />,
  );
  await settle();
  await click(el.querySelector('[data-space-row] [data-create="tab"]'));
  await settle();
  await choose("claude");
  await click(submitButton());
  await settle();

  expect(nav).toEqual([paneHash("w1:p9")]);
  expect(calls).toContain("startAgent w1:p9 claude api-refactor");
  // Started and finished: the notice clears itself rather than leaving
  // `starting claude…` on a pane that now has an agent.
  expect(useLaunch.getState().launch).toBeNull();
  await unmount();
});

test("a PARTIAL failure still navigates, and says the agent did not start", async () => {
  // The route reports this case distinctly — "shell exists, but the agent did
  // not start: …", with `paneId` echoed even on the 502 — because the pane the
  // operator asked for is real either way. A tab they did not have before must
  // not be invisible to them, so paddock navigates anyway and says what
  // happened.
  withTree(true);
  const detail = "shell exists, but the agent did not start: herdr timed out";
  const { senders } = recorder({
    startAgent: async () => { throw new RequestFailed(502, detail); },
  });
  const nav: string[] = [];
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={(h) => nav.push(h)} />,
  );
  await settle();
  await click(el.querySelector('[data-space-row] [data-create="tab"]'));
  await settle();
  await choose("claude");
  await click(submitButton());
  await settle();

  expect(nav).toEqual([paneHash("w1:p9")]);
  const launch = useLaunch.getState().launch;
  expect(launch).toEqual({ paneId: "w1:p9", kind: "claude", phase: "failed", detail });
  await unmount();

  // And it is on screen, on that pane, verbatim.
  const notice = await render(<LaunchNotice paneId="w1:p9" />);
  expect(notice.textContent).toContain("claude did not start");
  expect(notice.textContent).toContain(detail);
  await unmount();
});

test("a 200 whose body says ok:false is a failed start, not a success", async () => {
  // "Never a success that hides a failed start" (§9.2). The route sends no such
  // body today; a client that reads only the status code is one route change
  // away from breaking the rule silently.
  withTree(true);
  const { senders } = recorder({
    startAgent: async (paneId) => ({ ok: false, detail: "no manifest for that kind", paneId }),
  });
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  await click(el.querySelector('[data-space-row] [data-create="tab"]'));
  await settle();
  await choose("codex");
  await click(submitButton());
  await settle();
  expect(useLaunch.getState().launch?.phase).toBe("failed");
  expect(useLaunch.getState().launch?.detail).toBe("no manifest for that kind");
  await unmount();
});

test("the launch notice belongs to its pane, and only to it", async () => {
  useLaunch.setState({ launch: { paneId: "w1:p9", kind: "claude", phase: "starting", detail: null } });
  const mine = await render(<LaunchNotice paneId="w1:p9" />);
  expect(mine.textContent).toContain("starting claude…");
  await unmount();

  // Navigating elsewhere must not carry the banner along.
  const other = await render(<LaunchNotice paneId="w2:p1" />);
  expect(other.textContent).toBe("");
  await unmount();
});

test("a failed launch notice is dismissed by the operator, never on a timer", async () => {
  useLaunch.setState({ launch: { paneId: "w1:p9", kind: "aider", phase: "failed", detail: "boom" } });
  const el = await render(<LaunchNotice paneId="w1:p9" />);
  const dismiss = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Dismiss"));
  expect(dismiss).toBeDefined();
  await click(dismiss);
  expect(useLaunch.getState().launch).toBeNull();
  expect(el.textContent).toBe("");
  await unmount();
});

test("a FAILED create navigates nowhere and keeps herdr's own words on screen", async () => {
  // §11: every herdr error verbatim, and the sheet stays open. A management
  // screen that quietly fails to create something is worse than one with no
  // create at all.
  withTree(true);
  const { senders } = recorder({
    createSpace: async () => { throw new RequestFailed(502, "workspace.create: no room at the inn"); },
  });
  const { state, load } = counted(TREE);
  const nav: string[] = [];
  const el = await render(
    <Spaces onBack={() => {}} load={load} createSenders={senders} navigate={(h) => nav.push(h)} />,
  );
  await settle();
  const before = state.loads;
  await click(el.querySelector('.spaces-head [data-create="space"]'));
  await settle();
  await click(submitButton());
  await settle();

  expect(nav).toEqual([]);
  expect(sheet().textContent).toContain("workspace.create: no room at the inn");
  // Refetched on the failure too, so the screen shows what herdr holds rather
  // than what was asked for.
  expect(state.loads).toBeGreaterThan(before);
  await unmount();
});

test("the sheet reopens blank, never carrying the last attempt's error or draft", async () => {
  withTree(true);
  const { senders } = recorder({
    createTab: async () => { throw new RequestFailed(502, "herdr refused"); },
  });
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={() => {}} />,
  );
  await settle();
  const plus = el.querySelector<HTMLButtonElement>('[data-space-row] [data-create="tab"]');
  await click(plus);
  await settle();
  await typeInto(field("label"), "half-typed");
  await click(submitButton());
  await settle();
  expect(sheet().textContent).toContain("herdr refused");

  const cancel = [...sheet().querySelectorAll("button")].find((b) => b.textContent === "Cancel");
  await click(cancel);
  await settle();
  await click(plus);
  await settle();
  expect(field("label").value).toBe("");
  expect(sheet().textContent).not.toContain("herdr refused");
  await unmount();
});

test("the header's sheet and a row's sheet are the same component, scoped differently", async () => {
  // A direct render, so the scope is asserted against the component's own
  // contract rather than through the screen that positions it.
  const { senders, calls } = recorder();
  const el = await render(
    <CreateSheet
      target={{ kind: "tab", spaceId: "w7", spaceLabel: "schema migration", spaceCwd: "/srv/db" }}
      cwds={["/srv/db"]}
      onChanged={() => {}}
      senders={senders}
      navigate={() => {}}
    />,
  );
  await settle();
  await click(el.querySelector("[data-create]"));
  await settle();
  expect(sheet().textContent).toContain("New tab in schema migration");
  await choose("claude");
  expect(field("name").value).toBe("schema-migration");
  await click(submitButton());
  await settle();
  expect(calls).toContain('createTab w7 {"cwd":"/srv/db"}');
  await unmount();
});

test("a 200 that says ok:false never becomes a navigation", async () => {
  // `readJson` rejects a non-2xx but validates nothing about a 200's body, so
  // this resolves as a value TypeScript believes is a success. Unguarded it
  // navigated to `#/pane/undefined` — a create reported as working, landing on
  // a pane that does not exist. `launch.ts` already refuses the same shape on
  // the spawn side; the create side has to match.
  withTree(true);
  const { senders } = recorder({
    createSpace: async () => ({ ok: false, detail: "herdr had no room", spaceId: "", tabId: "", paneId: "" }),
  });
  const nav: string[] = [];
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={(h) => nav.push(h)} />,
  );
  await settle();
  await click(el.querySelector('.spaces-head [data-create="space"]'));
  await settle();
  await click(submitButton());
  await settle();
  expect(nav).toEqual([]);
  expect(sheet().textContent).toContain("herdr had no room");
  await unmount();
});

test("a 200 with no pane id never becomes a navigation either", async () => {
  withTree(true);
  const { senders } = recorder({
    // The shape a malformed 200 actually has: `ok` true, `paneId` missing.
    createTab: async (spaceId) => ({ ok: true, tabId: `${spaceId}:t9` } as never),
  });
  const nav: string[] = [];
  const el = await render(
    <Spaces onBack={() => {}} load={async () => TREE} createSenders={senders} navigate={(h) => nav.push(h)} />,
  );
  await settle();
  await click(el.querySelector('[data-space-row] [data-create="tab"]'));
  await settle();
  await click(submitButton());
  await settle();
  expect(nav).toEqual([]);
  expect(nav.join("")).not.toContain("undefined");
  expect(sheet().textContent).toContain("named no pane");
  await unmount();
});
