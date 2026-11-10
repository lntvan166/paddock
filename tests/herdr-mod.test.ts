import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@server/cli";
import { addPaddock, PANEL_ID, TOGGLE_ID, type LayoutNode } from "@server/herdr-mod/layout";
import { installMod, selfBinary, type HerdrAppControl } from "@server/herdr-mod/install";

/**
 * `paddock mod install`: the Herdr app mod in `herdr/paddock/mods/paddock/`, copied
 * into the app's home, and optionally a button and panel added to one of the
 * person's layouts. Everything here runs against a temporary app home: the
 * operator's own Herdr app is never touched by a test.
 */

// The shape of Herdr's own `main` layout (sidebar | work column of tab bar over panes).
const mainLike = (): LayoutNode => ({
  id: "root", type: "row",
  children: [
    { id: "sidebar", type: "column", size: { px: 240 }, children: [{ id: "spaces", type: "block", content: { mod: "spaces" } }] },
    { id: "work", type: "column", children: [
      { id: "tabs", type: "block", size: { px: 30 }, content: { mod: "tabs" } },
      { id: "main", type: "block", content: { tab: "active" } },
    ] },
  ],
});

// A layout that already puts the tab bar and the panes in rows (like skillshare's).
const rowsLike = (): LayoutNode => ({
  id: "root", type: "row",
  children: [{ id: "work", type: "column", children: [
    { id: "tabs-row", type: "row", size: { px: 42 }, children: [{ id: "tabs", type: "block", content: { mod: "better-tabs" } }] },
    { id: "work-body", type: "row", children: [{ id: "main", type: "block", content: { tab: "active" } }] },
  ] }],
});

function byId(n: LayoutNode, id: string): LayoutNode | null {
  if (n.id === id) return n;
  for (const c of n.children ?? []) { const f = byId(c, id); if (f) return f; }
  return null;
}
function parentOf(n: LayoutNode, id: string): LayoutNode | null {
  for (const c of n.children ?? []) { if (c.id === id) return n; const f = parentOf(c, id); if (f) return f; }
  return null;
}
function allIds(n: LayoutNode): string[] {
  return [n.id!, ...(n.children ?? []).flatMap(allIds)];
}

test("main-like layout: the tab bar and the panes each become a row with paddock beside them", () => {
  const r = addPaddock(mainLike());
  if (!r.ok) throw new Error(r.reason);
  expect(r.changed).toBe(true);
  const toggleRow = parentOf(r.tree, TOGGLE_ID)!;
  expect(toggleRow.type).toBe("row");
  expect(toggleRow.size).toEqual({ px: 30 }); // the tab bar's height moved to the row
  expect(toggleRow.children!.map((c) => c.id)).toEqual(["tabs", TOGGLE_ID]);
  expect(byId(r.tree, "tabs")!.size).toEqual({ weight: 1 });
  expect(byId(r.tree, TOGGLE_ID)!.content).toEqual({ mod: "paddock", props: { role: "toggle" } });

  const panel = byId(r.tree, PANEL_ID)!;
  expect(panel.hidden).toBe(true); // shown by the button, not on install
  expect(parentOf(r.tree, PANEL_ID)!.children!.map((c) => c.id)).toEqual(["main", PANEL_ID]);
  expect(panel.children![0]!.content).toEqual({ mod: "paddock" });
  // Ids stay unique: Herdr's commands address nodes by id.
  const ids = allIds(r.tree);
  expect(new Set(ids).size).toBe(ids.length);
});

test("rows-like layout: paddock goes into the existing rows, nothing is wrapped", () => {
  const r = addPaddock(rowsLike());
  if (!r.ok) throw new Error(r.reason);
  expect(byId(r.tree, "tabs-row")!.children!.map((c) => c.id)).toEqual(["tabs", TOGGLE_ID]);
  expect(byId(r.tree, "work-body")!.children!.map((c) => c.id)).toEqual(["main", PANEL_ID]);
  expect(byId(r.tree, "tabs")!.size).toBeUndefined();
});

test("running it twice changes nothing the second time, and never touches the input", () => {
  const input = mainLike();
  const before = JSON.stringify(input);
  const first = addPaddock(input);
  expect(JSON.stringify(input)).toBe(before);
  if (!first.ok) throw new Error(first.reason);
  const second = addPaddock(first.tree);
  expect(second).toEqual({ ok: true, tree: first.tree, changed: false });
});

test("a layout with no tab bar or no panes block is refused with why", () => {
  const noTabs = addPaddock({ id: "root", type: "row", children: [{ id: "m", type: "block", content: { tab: "active" } }] });
  expect(noTabs.ok).toBe(false);
  if (!noTabs.ok) expect(noTabs.reason).toContain("tab bar");
  const noPanes = addPaddock({ id: "root", type: "row", children: [{ id: "t", type: "block", content: { mod: "tabs" } }] });
  expect(noPanes.ok).toBe(false);
});

test("half an earlier install (only one of the two ids) is refused, not doubled", () => {
  const tree = mainLike();
  tree.children!.push({ id: PANEL_ID, type: "column", children: [] });
  const r = addPaddock(tree);
  expect(r.ok).toBe(false);
});

// ---- the install itself, in a temporary app home --------------------------

async function appHome(layout?: LayoutNode) {
  const home = await mkdtemp(join(tmpdir(), "paddock-herdr-app-"));
  if (layout) {
    await mkdir(join(home, "layouts"));
    await writeFile(join(home, "layouts", "mine.json"), JSON.stringify(layout));
  }
  return home;
}

test("install copies the mod and names the binary it should run", async () => {
  const home = await appHome();
  const log: string[] = [];
  expect(await installMod({ appHome: home, bin: "/path/to/paddock", log: (l) => log.push(l) })).toBe(0);
  const dir = join(home, "mods", "paddock");
  expect((await readdir(dir)).sort()).toEqual(["close.svg", "config.json", "main.js", "mark.svg", "mod.json", "spinner.svg"]);
  expect(JSON.parse(await readFile(join(dir, "config.json"), "utf8"))).toEqual({ bin: "/path/to/paddock" });
  // The copy is the repo's file, byte for byte.
  expect(await readFile(join(dir, "main.js"), "utf8")).toBe(await readFile("herdr/paddock/mods/paddock/main.js", "utf8"));
});

test("install with --layout adds the panel and keeps the old file beside it", async () => {
  const home = await appHome(mainLike());
  const log: string[] = [];
  expect(await installMod({ appHome: home, bin: null, layout: "mine", log: (l) => log.push(l), now: () => 42 })).toBe(0);
  const tree = JSON.parse(await readFile(join(home, "layouts", "mine.json"), "utf8"));
  expect(byId(tree, PANEL_ID)).not.toBeNull();
  expect(JSON.parse(await readFile(join(home, "layouts", "mine.json.before-paddock-42"), "utf8"))).toEqual(mainLike());
  expect(existsSync(join(home, "layouts", "mine.json.paddock-tmp"))).toBe(false);
});

test("install refuses Herdr's own layouts, before writing anything", async () => {
  const home = await appHome();
  const log: string[] = [];
  expect(await installMod({ appHome: home, bin: null, layout: "main", log: (l) => log.push(l) })).toBe(1);
  expect(log.join("\n")).toContain("layout.clone");
  expect(existsSync(join(home, "mods"))).toBe(false);
});

test("install into a layout that does not exist fails before writing anything", async () => {
  const home = await appHome();
  expect(await installMod({ appHome: home, bin: null, layout: "nope", log: () => {} })).toBe(1);
  expect(existsSync(join(home, "mods"))).toBe(false);
});

test("no app home: install says so and writes nothing", async () => {
  const log: string[] = [];
  expect(await installMod({ appHome: "/nonexistent/herdr-app", bin: null, log: (l) => log.push(l) })).toBe(1);
  expect(log[0]).toContain("no Herdr app home");
});

// ---- no --layout: the layout the window shows -------------------------------

/** A Herdr app that shows `shown`; `clone` writes the copy the way the app does. */
function fakeApp(home: string, shown: { name: string } | { error: string }) {
  const calls: string[] = [];
  const app: HerdrAppControl = {
    async shownLayout() { calls.push("status"); return shown; },
    async clone(name, as) {
      calls.push(`clone ${name} ${as}`);
      await mkdir(join(home, "layouts"), { recursive: true });
      await writeFile(join(home, "layouts", `${as}.json`), JSON.stringify(mainLike()));
    },
    async switchTo(name) { calls.push(`switch ${name}`); },
  };
  return { app, calls };
}

test("no --layout: the button goes into the layout the window shows", async () => {
  const home = await appHome(mainLike());
  const { app } = fakeApp(home, { name: "mine" });
  const log: string[] = [];
  expect(await installMod({ appHome: home, bin: null, app, log: (l) => log.push(l), now: () => 7 })).toBe(0);
  const tree = JSON.parse(await readFile(join(home, "layouts", "mine.json"), "utf8"));
  expect(byId(tree, TOGGLE_ID)).not.toBeNull();
  expect(byId(tree, PANEL_ID)).not.toBeNull();
  expect(existsSync(join(home, "mods", "paddock", "main.js"))).toBe(true);
});

test("no --layout on Herdr's own layout: copies it as my-<name>, switches, and adds the button there", async () => {
  const home = await appHome();
  const { app, calls } = fakeApp(home, { name: "main" });
  const log: string[] = [];
  expect(await installMod({ appHome: home, bin: null, app, log: (l) => log.push(l) })).toBe(0);
  expect(calls).toEqual(["status", "clone main my-main"]);
  const tree = JSON.parse(await readFile(join(home, "layouts", "my-main.json"), "utf8"));
  expect(byId(tree, TOGGLE_ID)).not.toBeNull();
  expect(existsSync(join(home, "layouts", "main.json"))).toBe(false);
  expect(log.join("\n")).toContain("replaces on every start");
});

test("no --layout on Herdr's own layout with a copy already there: switches to the copy, no second clone", async () => {
  const home = await appHome();
  await mkdir(join(home, "layouts"));
  await writeFile(join(home, "layouts", "my-main.json"), JSON.stringify(mainLike()));
  const { app, calls } = fakeApp(home, { name: "main" });
  expect(await installMod({ appHome: home, bin: null, app, log: () => {} })).toBe(0);
  expect(calls).toEqual(["status", "switch my-main"]);
  expect(byId(JSON.parse(await readFile(join(home, "layouts", "my-main.json"), "utf8")), TOGGLE_ID)).not.toBeNull();
});

test("a clone whose file never appears fails, and writes no mod files", async () => {
  const home = await appHome();
  const app: HerdrAppControl = {
    async shownLayout() { return { name: "main" }; },
    async clone() {},
    async switchTo() {},
  };
  const log: string[] = [];
  expect(await installMod({ appHome: home, bin: null, app, log: (l) => log.push(l), cloneWaitMs: 100 })).toBe(1);
  expect(log.join("\n")).toContain("never appeared");
  expect(existsSync(join(home, "mods"))).toBe(false);
});

test("the app cannot say what it shows: the mod is installed, and the log says why there is no button and how to add it", async () => {
  const home = await appHome();
  const { app } = fakeApp(home, { error: "herdr-app is not on PATH" });
  const log: string[] = [];
  expect(await installMod({ appHome: home, bin: null, app, log: (l) => log.push(l) })).toBe(0);
  expect(existsSync(join(home, "mods", "paddock", "main.js"))).toBe(true);
  const out = log.join("\n");
  expect(out).toContain("herdr-app is not on PATH");
  expect(out).toContain("--button-only");
});

test("--button-only writes no mod files, only the layout", async () => {
  const home = await appHome(mainLike());
  const { app } = fakeApp(home, { name: "mine" });
  expect(await installMod({ appHome: home, bin: null, files: false, app, log: () => {} })).toBe(0);
  expect(existsSync(join(home, "mods"))).toBe(false);
  expect(byId(JSON.parse(await readFile(join(home, "layouts", "mine.json"), "utf8")), TOGGLE_ID)).not.toBeNull();
});

test("--button-only with no way to know the layout fails, instead of doing nothing quietly", async () => {
  const home = await appHome();
  const { app } = fakeApp(home, { error: "the Herdr app shows no layout (is its window open?)" });
  const log: string[] = [];
  expect(await installMod({ appHome: home, bin: null, files: false, app, log: (l) => log.push(l) })).toBe(1);
  expect(log.join("\n")).toContain("--layout");
});

test("--no-button installs the mod and never asks the app", async () => {
  const home = await appHome();
  const { app, calls } = fakeApp(home, { name: "mine" });
  expect(await installMod({ appHome: home, bin: null, button: false, app, log: () => {} })).toBe(0);
  expect(calls).toEqual([]);
  expect(existsSync(join(home, "mods", "paddock", "main.js"))).toBe(true);
});

test("selfBinary names a compiled paddock, never bun", () => {
  expect(selfBinary("/path/to/bin/paddock")).toBe("/path/to/bin/paddock");
  expect(selfBinary("/usr/local/bin/bun")).toBeNull();
});

test("the CLI parses mod install and its layout", () => {
  const p = parseArgs(["mod", "install", "--layout", "mine"]);
  expect(p.command).toBe("mod");
  expect(p.args).toEqual(["install"]);
  expect(p.values.get("--layout")).toBe("mine");
});
