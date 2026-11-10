/**
 * `paddock mod install [--layout <name>] [--no-button | --button-only]`: put
 * the paddock mod into the Herdr desktop app (`herdr/paddock/` in this repo)
 * and add its tab-bar button and panel to a layout.
 *
 * With no `--layout` the button goes into the layout the window is showing,
 * asked of `herdr-app status`. It used to need `--layout`, and an agent asked
 * to "install the paddock mod" ran the bare command, got a mod with no button,
 * and the person had no way to open it short of the command palette. When the
 * shown layout is one of Herdr's own, which it rewrites on every start, the
 * button goes into a copy (`my-<name>`) and the window switches to it.
 *
 * `--button-only` writes no mod files: it is what the panel runs when it was
 * installed from the gallery (whose files may be newer than this binary's)
 * and finds no button for itself.
 *
 * The mod files are embedded in the binary, so the mod always matches the
 * paddock that installed it: the mod calls `paddock status --json` and the
 * other verbs, and an older paddock has no `--json`. For the same reason the
 * install writes `config.json` naming THIS binary, so a second paddock on
 * PATH (an older release beside a source build) is never the one the mod runs.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
// File imports: Bun hands back a path into the binary's embedded files. TypeScript sees a
// JavaScript module with no declarations, hence the expected errors.
// @ts-expect-error -- a `type: "file"` import is a path, not a module
import mainJs from "../../../herdr/paddock/mods/paddock/main.js" with { type: "file" };
import modJson from "../../../herdr/paddock/mods/paddock/mod.json" with { type: "file" };
import markSvg from "../../../herdr/paddock/mods/paddock/mark.svg" with { type: "file" };
import closeSvg from "../../../herdr/paddock/mods/paddock/close.svg" with { type: "file" };
import spinnerSvg from "../../../herdr/paddock/mods/paddock/spinner.svg" with { type: "file" };
import { addPaddock, SHIPPED_LAYOUTS, type LayoutNode } from "./layout";

const FILES: Record<string, string> = {
  "main.js": mainJs as unknown as string,
  "mod.json": modJson as unknown as string,
  "mark.svg": markSvg as unknown as string,
  "close.svg": closeSvg as unknown as string,
  "spinner.svg": spinnerSvg as unknown as string,
};

/** What the install asks of the running Herdr app, through `herdr-app`. */
export interface HerdrAppControl {
  /** The layout the window shows, or why it cannot be known (no app, no window). */
  shownLayout(): Promise<{ name: string } | { error: string }>;
  /** Duplicate a layout as `as` and show it. */
  clone(name: string, as: string): Promise<void>;
  switchTo(name: string): Promise<void>;
}

export interface InstallOpts {
  /** The app's home: `$HERDR_APP_HOME`, else `~/.config/herdr-app`. */
  appHome: string;
  /** The paddock binary the mod should run, or null to leave it to PATH. */
  bin: string | null;
  layout?: string;
  /** Write the mod's files (default). False for `--button-only`. */
  files?: boolean;
  /** Add the button and panel to a layout (default). False for `--no-button`. */
  button?: boolean;
  /** Needed only when no `--layout` is given. */
  app?: HerdrAppControl;
  log: (line: string) => void;
  now?: () => number;
  /** How long to wait for a cloned layout's file to appear. */
  cloneWaitMs?: number;
}

function herdrApp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("herdr-app", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error((e as NodeJS.ErrnoException).code === "ENOENT" ? "herdr-app is not on PATH" : e.message)));
    p.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`herdr-app ${args[0]} exited ${code}: ${(err || out).trim()}`)));
  });
}

/** The real app, through its CLI. */
export const herdrAppCli: HerdrAppControl = {
  async shownLayout() {
    let text: string;
    try { text = await herdrApp(["status"]); }
    catch (e) { return { error: (e as Error).message }; }
    let layout: unknown;
    try { layout = (JSON.parse(text) as { layout?: unknown }).layout; }
    catch (e) { return { error: `herdr-app status did not print JSON: ${(e as Error).message}` }; }
    return typeof layout === "string" && layout
      ? { name: layout }
      : { error: "the Herdr app shows no layout (is its window open?)" };
  },
  async clone(name, as) { await herdrApp(["do", "layout.clone", JSON.stringify({ name, as })]); },
  async switchTo(name) { await herdrApp(["do", "layout.switch", JSON.stringify({ name })]); },
};

async function waitFor(path: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

export function defaultAppHome(env: Record<string, string | undefined> = process.env): string {
  return env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
}

/**
 * The binary to name in `config.json`: this one when it is a compiled paddock,
 * null under `bun src/server/index.ts` (the mod would run bun, not paddock).
 */
export function selfBinary(execPath = process.execPath): string | null {
  return basename(execPath).startsWith("bun") ? null : execPath;
}

export async function installMod(o: InstallOpts): Promise<number> {
  if (!existsSync(o.appHome)) {
    o.log(`paddock: no Herdr app home at ${o.appHome}`);
    o.log("  install the Herdr app and open it once, or set HERDR_APP_HOME");
    return 1;
  }

  const files = o.files !== false, button = o.button !== false;
  const later = () => {
    o.log("  add its button later: paddock mod install --button-only (in the layout the window shows),");
    o.log("  or --layout <name>; or open it from the command palette: mod.open paddock");
  };

  // Which layout gets the button, decided BEFORE anything is written: a
  // refused layout must not leave a half-done install behind.
  let target: string | null = null;
  let noButton: string | null = null;
  if (button && o.layout !== undefined) {
    if (SHIPPED_LAYOUTS.has(o.layout)) {
      o.log(`paddock: '${o.layout}' is one of Herdr's own layouts, which it replaces on every start`);
      o.log(`  clone it first, then install into the clone:`);
      o.log(`    herdr-app do layout.clone '{"name":"${o.layout}","as":"my-${o.layout}"}'`);
      o.log(`    paddock mod install --layout my-${o.layout}`);
      o.log(`  or leave out --layout while the window shows it, and paddock makes the copy`);
      return 1;
    }
    target = o.layout;
  } else if (button) {
    const shown = o.app ? await o.app.shownLayout() : { error: "no way to ask the Herdr app" };
    if ("error" in shown) {
      noButton = shown.error;
    } else if (SHIPPED_LAYOUTS.has(shown.name)) {
      // Herdr rewrites its own layouts on start: the button would vanish. A copy keeps it.
      const copy = `my-${shown.name}`;
      const copyPath = join(o.appHome, "layouts", `${copy}.json`);
      try {
        if (existsSync(copyPath)) {
          await o.app!.switchTo(copy);
          o.log(`the window showed Herdr's own '${shown.name}', which it replaces on every start;`);
          o.log(`  switched to your copy of it, '${copy}'`);
        } else {
          await o.app!.clone(shown.name, copy);
          if (!(await waitFor(copyPath, o.cloneWaitMs ?? 5000))) {
            o.log(`paddock: asked Herdr to copy '${shown.name}' as '${copy}', and ${copyPath} never appeared`);
            return 1;
          }
          o.log(`the window showed Herdr's own '${shown.name}', which it replaces on every start;`);
          o.log(`  copied it as '${copy}' and switched to the copy`);
        }
      } catch (e) {
        o.log(`paddock: could not copy Herdr's '${shown.name}' layout: ${(e as Error).message}`);
        return 1;
      }
      target = copy;
    } else {
      target = shown.name;
    }
  }

  let layoutPath: string | null = null;
  let tree: LayoutNode | null = null;
  if (target !== null) {
    layoutPath = join(o.appHome, "layouts", `${target}.json`);
    let text: string;
    try { text = await readFile(layoutPath, "utf8"); }
    catch (e) { o.log(`paddock: cannot read ${layoutPath}: ${(e as Error).message}`); return 1; }
    try { tree = JSON.parse(text) as LayoutNode; }
    catch (e) { o.log(`paddock: ${layoutPath} is not valid JSON: ${(e as Error).message}`); return 1; }
  }
  if (!files && noButton !== null) {
    o.log(`paddock: cannot tell which layout to add the button to: ${noButton}`);
    o.log("  name one: paddock mod install --button-only --layout <name>");
    return 1;
  }

  if (files) {
    const dir = join(o.appHome, "mods", "paddock");
    await mkdir(dir, { recursive: true });
    for (const [name, src] of Object.entries(FILES)) {
      await writeFile(join(dir, name), await readFile(src));
    }
    await writeFile(join(dir, "config.json"), JSON.stringify(o.bin ? { bin: o.bin } : {}, null, 2) + "\n");
    o.log(`installed the paddock mod in ${dir}`);
    if (o.bin) o.log(`  it runs ${o.bin}`);
  }

  if (layoutPath === null || tree === null) {
    if (noButton !== null) o.log(`  no tab-bar button yet: ${noButton}`);
    later();
    return 0;
  }

  const added = addPaddock(tree);
  if (!added.ok) {
    o.log(`paddock: could not add the panel to '${target}': ${added.reason}`);
    o.log("  the mod is installed; open it with mod.open paddock");
    return 1;
  }
  if (!added.changed) {
    o.log(`  '${target}' already has the paddock button and panel`);
    return 0;
  }
  // Kept beside it, then replaced in one rename, so the app never reads half a file.
  const backup = `${layoutPath}.before-paddock-${(o.now ?? Date.now)()}`;
  await copyFile(layoutPath, backup);
  const tmp = `${layoutPath}.paddock-tmp`;
  await writeFile(tmp, JSON.stringify(added.tree, null, 2) + "\n");
  await rename(tmp, layoutPath);
  o.log(`  added the paddock button beside your tabs, and its panel, to '${target}' (the old file is ${basename(backup)})`);
  o.log(`  if the app rejects it, it says why in layouts/${target}.error and keeps the last good one`);
  return 0;
}
