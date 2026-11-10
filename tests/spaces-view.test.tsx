import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { click, render, selectOption, settle, typeInto, unmount } from "./support/render";
import { CreateSheet, type CreateSenders } from "@web/components/CreateSheet";
import { Space } from "@web/components/Space";
import { Spaces } from "@web/components/Spaces";
import { useLaunch } from "@web/launch";
import { useStore } from "@web/store";
import type { SpaceTree } from "@shared/types";

/*
 * App spaces (herdr-core) on the Spaces screens. Invented names and `/srv/...`
 * paths only — the public repo rule.
 */

const TREE: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [
    {
      spaceId: "w1", label: "schema-migration", origin: "herdr", tabCount: 1, paneCount: 1,
      tabs: [{ tabId: "w1:t1", label: null, panes: [
        { paneId: "w1:p1", harness: "claude", name: "schema-migration", title: "x", cwd: "/srv/db", state: "working" },
      ] }],
    },
    {
      spaceId: "hc.spA", label: "api", origin: "core", tabCount: 1, paneCount: 1,
      tabs: [{ tabId: "hc.tbA", label: null, panes: [
        { paneId: "hc.t3", harness: "claude", name: "api-refactor", title: "x", cwd: "/srv/api", state: "idle" },
      ] }],
    },
  ],
};

function recorder(b: { core: boolean; app: boolean; herdr?: boolean }) {
  const backends = { herdr: true, ...b };
  const calls: string[] = [];
  const senders: CreateSenders = {
    harnesses: async () => ["claude", "codex"],
    backends: async () => backends,
    createSpace: async (opts) => {
      calls.push(`createSpace ${JSON.stringify(opts)}`);
      return { ok: true, spaceId: "hc.spN", tabId: "hc.tbN", paneId: "hc.t9" };
    },
    createTab: async (spaceId, opts) => {
      calls.push(`createTab ${spaceId} ${JSON.stringify(opts)}`);
      return { ok: true, tabId: "hc.tbN", paneId: "hc.t9" };
    },
    startAgent: async (paneId, kind, name, task) => {
      calls.push(`startAgent ${paneId} ${kind} ${name}${task ? ` task=${task}` : ""}`);
      return { ok: true, paneId };
    },
  };
  return { calls, senders };
}

function sheet(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-slot="sheet-content"]');
  if (!el) throw new Error("no sheet is open");
  return el;
}

const input = (name: string) => sheet().querySelector<HTMLInputElement>(`input[data-field="${name}"]`)!;
const select = (name: string) => sheet().querySelector<HTMLSelectElement>(`select[data-field="${name}"]`);

afterEach(async () => {
  await unmount();
  useLaunch.setState({ launch: null });
  useStore.setState({ spacesAvailable: false });
});

test("a core space carries the app mark in the list", async () => {
  const el = await render(<Spaces load={async () => TREE} />);
  await settle();
  const herdr = el.querySelector('[data-space-id="w1"]')!;
  const core = el.querySelector('[data-space-id="hc.spA"]')!;
  expect(core.querySelector(".origin-mark")?.textContent).toBe("app");
  expect(herdr.querySelector(".origin-mark")).toBeNull();
});

test("the space screen of a core space carries the app mark, and a herdr space does not", async () => {
  let el = await render(<Space spaceId="hc.spA" onBack={() => {}} load={async () => TREE} />);
  await settle();
  expect(el.querySelector(".space-screen-head .origin-mark")?.textContent).toBe("app");
  await unmount();
  el = await render(<Space spaceId="w1" onBack={() => {}} load={async () => TREE} />);
  await settle();
  expect(el.querySelector(".origin-mark")).toBeNull();
});

async function openTabSheet(backends: { core: boolean; app: boolean }) {
  const r = recorder(backends);
  await render(
    <CreateSheet
      target={{ kind: "tab", spaceId: "hc.spA", spaceLabel: "api", spaceCwd: "/srv/api", spaceOrigin: "core" }}
      cwds={[]} onChanged={() => {}} senders={r.senders} navigate={() => {}}
    />,
  );
  await click(document.querySelector('[data-create="tab"]'));
  await settle();
  return r;
}

test("with the app closed the create sheet says Open Herdr to name it now for an app space", async () => {
  await openTabSheet({ core: true, app: false });
  expect(input("label").disabled).toBe(true);
  expect(sheet().textContent + input("label").placeholder).toContain("Open Herdr to name it now");
});

test("with the app running the name field of an app space is open", async () => {
  await openTabSheet({ core: true, app: true });
  expect(input("label").disabled).toBe(false);
  expect(sheet().textContent).not.toContain("Open Herdr to name it now");
});

test("a tab in an app space starts its agent AS the new terminal, never beside a shell", async () => {
  const navs: string[] = [];
  const r = recorder({ core: true, app: true });
  await render(
    <CreateSheet
      target={{ kind: "tab", spaceId: "hc.spA", spaceLabel: "api", spaceCwd: "/srv/api", spaceOrigin: "core" }}
      cwds={[]} onChanged={() => {}} senders={r.senders} navigate={(h) => navs.push(h)}
    />,
  );
  await click(document.querySelector('[data-create="tab"]'));
  await settle();
  await selectOption(select("kind")!, "claude");
  await click(sheet().querySelector("button[data-create-submit]"));
  await settle();
  expect(r.calls).toEqual([
    `createTab hc.spA ${JSON.stringify({ cwd: "/srv/api", kind: "claude", name: "api" })}`,
  ]);
  expect(navs).toEqual(["#/pane/hc.t9"]);
});

test("a new space offers the app only when herdr-core is connected, and sends origin core when chosen", async () => {
  // No core: the sheet is the TUI's sheet, unchanged.
  let r = recorder({ core: false, app: false });
  await render(<CreateSheet target={{ kind: "space" }} cwds={[]} onChanged={() => {}} senders={r.senders} navigate={() => {}} />);
  await click(document.querySelector('[data-create="space"]'));
  await settle();
  expect(select("origin")).toBeNull();
  await unmount();

  r = recorder({ core: true, app: false });
  await render(<CreateSheet target={{ kind: "space" }} cwds={[]} onChanged={() => {}} senders={r.senders} navigate={() => {}} />);
  await click(document.querySelector('[data-create="space"]'));
  await settle();
  // Terminal herdr stays the default for a brand-new space.
  expect(select("origin")!.value).toBe("herdr");
  expect(input("label").disabled).toBe(false);
  await selectOption(select("origin")!, "core");
  expect(input("label").disabled).toBe(true);
  expect(sheet().textContent + input("label").placeholder).toContain("Open Herdr to name it now");
  await click(sheet().querySelector("button[data-create-submit]"));
  await settle();
  expect(r.calls).toEqual([`createSpace ${JSON.stringify({ origin: "core" })}`]);
});

test("app-only: a new space defaults to the app, and sends origin core", async () => {
  const r = recorder({ herdr: false, core: true, app: false });
  await render(<CreateSheet target={{ kind: "space" }} cwds={[]} onChanged={() => {}} senders={r.senders} navigate={() => {}} />);
  await click(document.querySelector('[data-create="space"]'));
  await settle();
  expect(select("origin")!.value).toBe("core");
  await click(sheet().querySelector("button[data-create-submit]"));
  await settle();
  expect(r.calls).toEqual([`createSpace ${JSON.stringify({ origin: "core" })}`]);
});

test("app-only: the dial's quick flow creates in the only connected backend", async () => {
  const r = recorder({ herdr: false, core: true, app: false });
  await render(
    <CreateSheet target={{ kind: "space" }} preset="shell" openWhen cwds={[]} onChanged={() => {}} senders={r.senders} navigate={() => {}} />,
  );
  await settle();
  // Quick mode never asks "Where".
  expect(select("origin")).toBeNull();
  await click(sheet().querySelector("button[data-create-submit]"));
  await settle();
  expect(r.calls).toEqual([`createSpace ${JSON.stringify({ origin: "core" })}`]);
});

test("with both backends up, terminal herdr stays the default", async () => {
  const r = recorder({ herdr: true, core: true, app: true });
  await render(
    <CreateSheet target={{ kind: "space" }} preset="shell" openWhen cwds={[]} onChanged={() => {}} senders={r.senders} navigate={() => {}} />,
  );
  await settle();
  await click(sheet().querySelector("button[data-create-submit]"));
  await settle();
  expect(r.calls).toEqual([`createSpace ${JSON.stringify({})}`]);
});

// A task at start: the agent begins on it instead of an empty prompt.
test("an app tab started with a task carries the task in its create", async () => {
  const r = await openTabSheet({ core: true, app: true });
  expect(sheet().querySelector('textarea[data-field="task"]')).toBeNull(); // a shell has no task
  await selectOption(select("kind")!, "claude");
  const task = sheet().querySelector<HTMLTextAreaElement>('textarea[data-field="task"]')!;
  expect(task).not.toBeNull();
  await typeInto(task, "Split the auth module");
  await click(sheet().querySelector("button[data-create-submit]"));
  await settle();
  expect(r.calls).toEqual([
    `createTab hc.spA ${JSON.stringify({ cwd: "/srv/api", kind: "claude", name: "api", task: "Split the auth module" })}`,
  ]);
});
