import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { warn as termWarn } from "@server/term";

export interface PaddockState {
  pid: number;
  /** What `ps` said about this process at startup. See capturedArgs. */
  args: string;
  port: number;
  version: string;
  startedAt: number;
}

export interface Probe {
  isAlive(pid: number): boolean;
  argsOf(pid: number): string | null;
}

export type StateCheck =
  | { kind: "none" }
  | { kind: "unreadable"; error: string }
  | { kind: "stale"; state: PaddockState }
  | { kind: "mismatch"; state: PaddockState; actual: string | null }
  | { kind: "running"; state: PaddockState };

export function stateFile(dir: string): string {
  // NOT paddock.pid — a .pid file conventionally holds one integer, and
  // anything reading one would mis-parse this.
  return join(dir, "paddock.state.json");
}

/**
 * What `ps` says about a pid, or null if it says nothing.
 *
 * This is the ONLY way the identity string is ever produced, at startup and at
 * stop alike, so the two are always comparable. It cannot be rebuilt from
 * `Bun.argv`: measured on a compiled binary invoked as `./bin/probe start`,
 * `ps` reports `"./bin/probe start"` — the invocation as typed — while
 * `Bun.argv` reports `["bun", "/$bunfs/root/probe", "start"]`.
 */
export function capturedArgs(pid: number): string | null {
  // /proc first. It needs no subprocess, and it is the ONLY thing that works in
  // the image this project ships: oven/bun:1-alpine has busybox ps, which
  // supports neither -p nor a selectable args column, so `ps -p 1 -o args=`
  // exits 1 there. Relying on ps alone would make `stop` refuse every time
  // inside Docker. Measured: /proc and ps return byte-identical strings on
  // Linux, so falling back between them is safe.
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const joined = raw.replace(/\0+$/, "").split("\0").join(" ").trim();
    if (joined !== "") return joined;
  } catch {
    // No /proc — macOS. Fall through to ps, which works there.
  }
  const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="]);
  if (r.exitCode !== 0) return null;
  const out = new TextDecoder().decode(r.stdout).trim();
  return out === "" ? null : out;
}

export const systemProbe: Probe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM means the process EXISTS but belongs to another user. Treating
      // that as dead would report "not running" while a paddock is plainly
      // serving; it is a mismatch case, not an absence.
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  argsOf: capturedArgs,
};

export async function writeState(dir: string, s: PaddockState): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = stateFile(dir);
  const tmp = `${file}.tmp`;
  const fh = await open(tmp, "w", 0o600);
  try {
    await fh.writeFile(JSON.stringify(s, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(tmp, 0o600); // `open`'s mode is subject to the umask; this is not
  await rename(tmp, file);
}

export interface RecordStateDeps {
  /** Injected so a test can drive the "cannot identify myself" path. */
  capture?: (pid: number) => string | null;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * Record a serving instance's own state file, or explain why it was not.
 *
 * Never throws, on purpose. The dashboard is the product; `status` and `stop`
 * are conveniences on top of it, and neither an unwritable config dir nor an
 * unreadable command line may take down a paddock that has already bound its
 * port.
 *
 * It refuses to write an identity it could not capture, rather than
 * substituting a placeholder. `capturedArgs` maps empty to null on both its
 * branches and so never returns `""`; a recorded `""` was therefore an
 * identity guaranteed to mismatch for ever, and `status` and `stop` would both
 * go on to declare a healthy instance "not paddock any more" and delete its
 * state file. Not being tracked is a smaller failure than being mis-tracked,
 * and unlike the latter it is announced.
 */
export async function recordState(
  dir: string,
  s: Omit<PaddockState, "args">,
  deps: RecordStateDeps = {},
): Promise<boolean> {
  const capture = deps.capture ?? capturedArgs;
  const log = deps.log ?? console.info;
  const warn = deps.warn ?? termWarn;

  // Inside the guard, not outside it: `capturedArgs` falls back to
  // Bun.spawnSync(["ps", ...]), which THROWS if `ps` is absent rather than
  // returning a non-zero exit. This function is called at top level right
  // after the bind, so an escaping throw would kill an already-serving
  // paddock — the exact failure 0f61f9a fixed for the config directory, and
  // the one the contract above promises cannot happen here.
  let args: string | null;
  try {
    args = capture(s.pid);
  } catch (e) {
    warn(
      `paddock: could not read pid ${s.pid}'s own command line (${String(e)}) — ` +
        "not recording state, so `paddock status` and `paddock stop` will not find this instance",
    );
    return false;
  }
  if (args === null) {
    log(
      `paddock: could not read pid ${s.pid}'s own command line — not recording state, ` +
        "so `paddock status` and `paddock stop` will not find this instance",
    );
    return false;
  }

  try {
    await writeState(dir, { ...s, args });
    return true;
  } catch (e) {
    warn(
      `paddock: could not record state (${String(e)}) — 'paddock stop' will not find this process`,
    );
    return false;
  }
}

export async function removeState(dir: string): Promise<void> {
  await rm(stateFile(dir), { force: true });
}

export async function checkState(
  dir: string,
  probe: Probe = systemProbe,
  log: (line: string) => void = termWarn,
): Promise<StateCheck> {
  let raw: string;
  try {
    raw = await readFile(stateFile(dir), "utf8");
  } catch (e) {
    // ENOENT — no file — is the ordinary case, not an error. Anything else
    // (EACCES, ENOTDIR, ...) is a real I/O failure and must NOT collapse into
    // "none": that would tell `start` the coast is clear and let it spawn a
    // second instance right alongside one that is already serving.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable", error: (e as Error).message };
  }

  let s: PaddockState;
  try {
    s = JSON.parse(raw) as PaddockState;
    if (typeof s.pid !== "number" || typeof s.args !== "string")
      throw new Error("shape");
  } catch (e) {
    // "none" is the right answer — treating garbage as "running" would let one
    // garbled file block every start — but it must not be a silent one. This
    // answer makes `start` spawn a second instance beside a live one and
    // `status` report "not running" while paddock is serving, so an operator
    // who is not told has no way to connect either symptom to its cause.
    log(
      `paddock: ignoring unusable state file ${stateFile(dir)} (${(e as Error).message}) ` +
        "— treating it as 'not running'",
    );
    return { kind: "none" };
  }

  if (!probe.isAlive(s.pid)) return { kind: "stale", state: s };

  let actual: string | null;
  try {
    actual = probe.argsOf(s.pid);
  } catch (e) {
    // argsOf can throw, not merely return null: the default probe falls back
    // to Bun.spawnSync(["ps", ...]) where /proc does not exist, and that
    // THROWS when `ps` is absent rather than returning a non-zero exit.
    //
    // Letting it escape crashes all three verbs. Reporting it as `mismatch`
    // would be worse than crashing — every mismatch arm deletes the state
    // file, so one machine without `ps` would quietly untrack a healthy
    // instance. "Could not look" is precisely what `unreadable` already means,
    // and every caller already refuses on it without touching the file.
    return {
      kind: "unreadable",
      error: `could not identify pid ${s.pid} (${(e as Error).message})`,
    };
  }
  if (actual !== s.args) return { kind: "mismatch", state: s, actual };
  return { kind: "running", state: s };
}
