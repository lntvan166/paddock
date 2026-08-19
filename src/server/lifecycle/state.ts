import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  await chmod(tmp, 0o600);   // `open`'s mode is subject to the umask; this is not
  await rename(tmp, file);
}

export async function removeState(dir: string): Promise<void> {
  await rm(stateFile(dir), { force: true });
}

export async function checkState(dir: string, probe: Probe = systemProbe): Promise<StateCheck> {
  let raw: string;
  try {
    raw = await readFile(stateFile(dir), "utf8");
  } catch {
    // Absent is the ordinary case, not an error.
    return { kind: "none" };
  }

  let s: PaddockState;
  try {
    s = JSON.parse(raw) as PaddockState;
    if (typeof s.pid !== "number" || typeof s.args !== "string") throw new Error("shape");
  } catch {
    // Unreadable state is indistinguishable from no state, and treating it as
    // "running" would let a garbled file block every start.
    return { kind: "none" };
  }

  if (!probe.isAlive(s.pid)) return { kind: "stale", state: s };
  const actual = probe.argsOf(s.pid);
  if (actual !== s.args) return { kind: "mismatch", state: s, actual };
  return { kind: "running", state: s };
}
