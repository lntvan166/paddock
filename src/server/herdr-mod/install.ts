/**
 * `paddock mod install [--layout <name>]`: put the paddock mod into the Herdr
 * desktop app (`herdr/paddock/` in this repo), and optionally add its
 * button and panel to one of the person's layouts.
 *
 * The mod files are embedded in the binary, so the mod always matches the
 * paddock that installed it: the mod calls `paddock status --json` and the
 * other verbs, and an older paddock has no `--json`. For the same reason the
 * install writes `config.json` naming THIS binary, so a second paddock on
 * PATH (an older release beside a source build) is never the one the mod runs.
 */
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

export interface InstallOpts {
  /** The app's home: `$HERDR_APP_HOME`, else `~/.config/herdr-app`. */
  appHome: string;
  /** The paddock binary the mod should run, or null to leave it to PATH. */
  bin: string | null;
  layout?: string;
  log: (line: string) => void;
  now?: () => number;
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

  // The layout is checked BEFORE anything is written: a refused layout must
  // not leave a half-done install behind.
  let layoutPath: string | null = null;
  let tree: LayoutNode | null = null;
  if (o.layout !== undefined) {
    if (SHIPPED_LAYOUTS.has(o.layout)) {
      o.log(`paddock: '${o.layout}' is one of Herdr's own layouts, which it replaces on every start`);
      o.log(`  clone it first, then install into the clone:`);
      o.log(`    herdr-app do layout.clone '{"name":"${o.layout}","as":"my-${o.layout}"}'`);
      o.log(`    paddock mod install --layout my-${o.layout}`);
      return 1;
    }
    layoutPath = join(o.appHome, "layouts", `${o.layout}.json`);
    let text: string;
    try { text = await readFile(layoutPath, "utf8"); }
    catch (e) { o.log(`paddock: cannot read ${layoutPath}: ${(e as Error).message}`); return 1; }
    try { tree = JSON.parse(text) as LayoutNode; }
    catch (e) { o.log(`paddock: ${layoutPath} is not valid JSON: ${(e as Error).message}`); return 1; }
  }

  const dir = join(o.appHome, "mods", "paddock");
  await mkdir(dir, { recursive: true });
  for (const [name, src] of Object.entries(FILES)) {
    await writeFile(join(dir, name), await readFile(src));
  }
  await writeFile(join(dir, "config.json"), JSON.stringify(o.bin ? { bin: o.bin } : {}, null, 2) + "\n");
  o.log(`installed the paddock mod in ${dir}`);
  if (o.bin) o.log(`  it runs ${o.bin}`);

  if (layoutPath === null || tree === null) {
    o.log("  open it with the command palette (mod.open paddock), or add its button and panel to a");
    o.log("  layout of yours: paddock mod install --layout <name>");
    return 0;
  }

  const added = addPaddock(tree);
  if (!added.ok) {
    o.log(`paddock: could not add the panel to '${o.layout}': ${added.reason}`);
    o.log("  the mod is installed; open it with mod.open paddock");
    return 1;
  }
  if (!added.changed) {
    o.log(`  '${o.layout}' already has the paddock button and panel`);
    return 0;
  }
  // Kept beside it, then replaced in one rename, so the app never reads half a file.
  const backup = `${layoutPath}.before-paddock-${(o.now ?? Date.now)()}`;
  await copyFile(layoutPath, backup);
  const tmp = `${layoutPath}.paddock-tmp`;
  await writeFile(tmp, JSON.stringify(added.tree, null, 2) + "\n");
  await rename(tmp, layoutPath);
  o.log(`  added the paddock button and panel to '${o.layout}' (the old file is ${basename(backup)})`);
  o.log(`  if the app rejects it, it says why in layouts/${o.layout}.error and keeps the last good one`);
  return 0;
}
