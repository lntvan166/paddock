# `paddock start` / `stop` / `status` — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let paddock outlive the terminal that started it, and let the
operator stop it again without hunting for a PID.

**Architecture:** A running paddock writes a JSON state file into
`$PADDOCK_CONFIG_DIR` after it binds, carrying its PID and its own `ps args=`
snapshot. `stop` and `status` read that file and verify the PID is both alive
and still the same command before touching it, refusing rather than guessing.

**Tech Stack:** Bun (`Bun.spawn`, `Bun.spawnSync`), POSIX signals, `ps`.

**Spec:** `docs/design/2026-08-19-lifecycle-commands-design.md`

## Global Constraints

- **This repository is PUBLIC.** No real hostnames, domains, home paths,
  usernames, machine names, employer terms or tunnel IDs in any file, comment,
  test or commit message. The repo's own GitHub URL is not a violation.
- **Refuse rather than guess.** Any mismatch between the state file and the
  live process means *do not signal it*. Killing an unrelated process is the
  worst outcome available to this feature.
- **Never swallow errors.** No empty catch blocks, no `2>/dev/null`, no
  unconditional `exit 0`.
- **`args` is captured from `ps`, never built from `Bun.argv`.** Measured: a
  compiled binary invoked as `./bin/probe start` has `ps args=` of
  `"./bin/probe start"` while `Bun.argv` is `["bun", "/$bunfs/root/probe",
  "start"]`. A reconstructed string would never match and would reject every
  legitimate stop.
- **No automatic `SIGKILL`.** `--force` is the operator's choice.
- **Bare `paddock` keeps serving**, `--demo` keeps working, and `agent`/`hub`
  keep exiting 2 with their roadmap pointer.
- **The state file is `paddock.state.json`, not `paddock.pid`**, and is written
  `0600` by the atomic tmp-then-rename path `settings.json` already uses.
- **No test may reach the network, signal a process it did not create, or write
  outside a temp directory.**
- Run `make check && make check-clean && make test` before every commit.
- **Prove each test can fail** by breaking the code it guards.

## File Structure

| File | Responsibility |
|---|---|
| `src/server/lifecycle/state.ts` (new) | The state file: shape, atomic write, removal, and the alive-and-matching check |
| `src/server/lifecycle/commands.ts` (new) | `start`, `stop`, `status` — each returns an exit code |
| `src/server/cli.ts` (mod) | Three new verbs and their usage lines |
| `src/server/index.ts` (mod) | Dispatch; write state after bind; remove it on exit |

---

### Task 1: The state file and its identity check

**Files:**
- Create: `src/server/lifecycle/state.ts`
- Test: `tests/lifecycle-state.test.ts`

**Interfaces:**
- Produces: `interface PaddockState { pid: number; args: string; port: number; version: string; startedAt: number }`;
  `stateFile(dir: string): string`; `writeState(dir, s): Promise<void>`;
  `removeState(dir): Promise<void>`; `capturedArgs(pid: number): string | null`;
  `type StateCheck = { kind: "none" } | { kind: "stale"; state: PaddockState } | { kind: "mismatch"; state: PaddockState; actual: string | null } | { kind: "running"; state: PaddockState }`;
  `checkState(dir: string, probe?: Probe): Promise<StateCheck>`;
  `interface Probe { isAlive(pid: number): boolean; argsOf(pid: number): string | null }`;
  `systemProbe: Probe`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lifecycle-state.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedArgs, checkState, removeState, stateFile, writeState,
  type PaddockState, type Probe,
} from "@server/lifecycle/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-state-"));
const state = (over: Partial<PaddockState> = {}): PaddockState => ({
  pid: 4242, args: "paddock", port: 8787, version: "0.4.0", startedAt: 1_700_000_000_000, ...over,
});
const probe = (alive: boolean, args: string | null): Probe =>
  ({ isAlive: () => alive, argsOf: () => args });

test("no state file means not running", async () => {
  expect((await checkState(await dir(), probe(false, null))).kind).toBe("none");
});

test("the file is written 0600 and round-trips", async () => {
  const d = await dir();
  await writeState(d, state());
  expect((await stat(stateFile(d))).mode & 0o777).toBe(0o600);
  const back = JSON.parse(await readFile(stateFile(d), "utf8"));
  expect(back).toEqual(state());
});

test("a dead PID is stale, not running", async () => {
  const d = await dir();
  await writeState(d, state());
  expect((await checkState(d, probe(false, null))).kind).toBe("stale");
});

test("a live PID running something else is a MISMATCH, never running", async () => {
  // The failure this prevents: the kernel recycled the PID, and `stop` would
  // otherwise signal a stranger.
  const d = await dir();
  await writeState(d, state({ args: "paddock" }));
  const got = await checkState(d, probe(true, "/usr/bin/postgres -D /var/lib/pg"));
  expect(got.kind).toBe("mismatch");
  if (got.kind === "mismatch") expect(got.actual).toContain("postgres");
});

test("alive and matching is running", async () => {
  const d = await dir();
  await writeState(d, state({ args: "paddock start" }));
  const got = await checkState(d, probe(true, "paddock start"));
  expect(got.kind).toBe("running");
  if (got.kind === "running") expect(got.state.port).toBe(8787);
});

test("a corrupt state file is treated as absent, not as a crash", async () => {
  const d = await dir();
  await writeFile(stateFile(d), "{ not json");
  expect((await checkState(d, probe(true, "paddock"))).kind).toBe("none");
});

test("removeState is idempotent", async () => {
  const d = await dir();
  await removeState(d);
  await writeState(d, state());
  await removeState(d);
  expect((await checkState(d, probe(true, "paddock"))).kind).toBe("none");
});

test("capturedArgs reads a real process — this one — and agrees with ps", () => {
  // The value stored at startup must come from the same source that will be
  // asked at stop time. There are two implementations (/proc on Linux, ps on
  // macOS) and CI only ever runs one, so assert they agree wherever both exist.
  const mine = capturedArgs(process.pid);
  expect(mine, "nothing returned for our own pid").toBeTruthy();
  expect(mine!.length).toBeGreaterThan(0);

  const viaPs = Bun.spawnSync(["ps", "-p", String(process.pid), "-o", "args="]);
  if (viaPs.exitCode === 0) {
    const text = new TextDecoder().decode(viaPs.stdout).trim();
    if (text !== "") expect(mine).toBe(text);
  }

  expect(capturedArgs(0x7fffffff)).toBeNull();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test tests/lifecycle-state.test.ts`
Expected: FAIL — cannot resolve `@server/lifecycle/state`.

- [ ] **Step 3: Implement**

Create `src/server/lifecycle/state.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/lifecycle-state.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Prove they can fail**

Change `checkState`'s last comparison to `return { kind: "running", state: s }`
unconditionally — the mismatch test must go RED. Restore it. This is the
assertion that stands between `stop` and someone else's process.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add src/server/lifecycle/state.ts tests/lifecycle-state.test.ts
git commit -m "feat: the lifecycle state file and its identity check

A bare PID cannot be verified: the kernel recycles PIDs, so a stale file plus
an unlucky reuse means stop signals a stranger. The file therefore carries what
ps said about the process at startup, and checkState refuses unless the pid is
alive AND still the same command.

The identity string is captured from ps at both ends rather than rebuilt from
Bun.argv, because they differ: a compiled binary invoked as ./bin/probe start
has ps args= of './bin/probe start' while Bun.argv is
['bun','/\$bunfs/root/probe','start']."
```

---

### Task 2: The running server writes and clears its state

**Files:**
- Modify: `src/server/index.ts`
- Test: `tests/lifecycle-server-state.test.ts`

**Interfaces:**
- Consumes: `writeState`, `removeState`, `capturedArgs`, `stateFile` (Task 1);
  `defaultConfigDir()` from `@server/settings/store`; `VERSION` from `@server/version`.

- [ ] **Step 1: Write the failing test**

Create `tests/lifecycle-server-state.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateFile } from "@server/lifecycle/state";

test("a running paddock writes its state after binding, and clears it on exit", async () => {
  const cfg = await mkdtemp(join(tmpdir(), "paddock-cfg-"));
  const port = 8930 + Math.floor(performance.now() % 40);
  const proc = Bun.spawn(["bun", "src/server/index.ts", "--demo"], {
    env: {
      ...process.env,
      PADDOCK_PORT: String(port),
      PADDOCK_CONFIG_DIR: cfg,
      PADDOCK_NO_UPDATE_CHECK: "1",
    },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    let body: string | null = null;
    for (let i = 0; i < 60 && body === null; i++) {
      try { body = await readFile(stateFile(cfg), "utf8"); } catch { await Bun.sleep(100); }
    }
    expect(body, "state file never appeared").not.toBeNull();
    const s = JSON.parse(body!);
    expect(s.pid).toBe(proc.pid);
    expect(s.port).toBe(port);
    expect(typeof s.args).toBe("string");
    expect(s.args.length).toBeGreaterThan(0);
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }

  // Removed on a clean SIGTERM, or every crash-free stop would leave litter
  // that the next `status` has to reason about.
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    try { await readFile(stateFile(cfg), "utf8"); await Bun.sleep(100); } catch { gone = true; }
  }
  expect(gone, "state file survived a clean shutdown").toBe(true);
}, 60_000);
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test tests/lifecycle-server-state.test.ts`
Expected: FAIL — the state file never appears.

- [ ] **Step 3: Implement**

In `src/server/index.ts`, add the imports:

```ts
import { capturedArgs, removeState, writeState } from "@server/lifecycle/state";
```

After `console.info(\`paddock listening on http://${HOSTNAME}:${PORT}\`);` add:

```ts
// Written AFTER the bind, deliberately. A paddock that failed to take the port
// must not overwrite the state of the one already holding it.
const stateDir = defaultConfigDir();
await writeState(stateDir, {
  pid: process.pid,
  args: capturedArgs(process.pid) ?? "",
  port: PORT,
  version: VERSION,
  startedAt: Date.now(),
});

// Foreground runs write it too, so `status` and `stop` do not depend on how
// paddock was started.
let clearing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (clearing) return;
    clearing = true;
    void removeState(stateDir)
      .catch((e) => console.info(`paddock: could not clear state file (${String(e)})`))
      .finally(() => process.exit(0));
  });
}
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/lifecycle-server-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove it can fail**

Move the `writeState` call to *before* `Bun.serve` — the test still passes, so
that is not the falsification. Instead delete the `removeState` signal handlers:
the "survived a clean shutdown" assertion must go RED. Restore them.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add src/server/index.ts tests/lifecycle-server-state.test.ts
git commit -m "feat: a running paddock records its state and clears it on exit

Written after the bind, so a paddock that lost the port race cannot overwrite
the state of the one holding it. Foreground runs write it too, so status and
stop work regardless of how paddock was started."
```

---

### Task 3: The verbs, and `paddock status`

**Files:**
- Modify: `src/server/cli.ts`, `src/server/index.ts`
- Create: `src/server/lifecycle/commands.ts`
- Test: `tests/lifecycle-status.test.ts`

**Interfaces:**
- Consumes: `checkState`, `Probe` (Task 1).
- Produces: `runStatus(opts: { dir: string; probe?: Probe; log?: (s: string) => void }): Promise<number>`;
  `Command` gains `"start" | "stop" | "status"`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lifecycle-status.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@server/cli";
import { runStatus } from "@server/lifecycle/commands";
import { writeState, type Probe } from "@server/lifecycle/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-status-"));
const probe = (alive: boolean, args: string | null): Probe =>
  ({ isAlive: () => alive, argsOf: () => args });
const s = { pid: 4242, args: "paddock", port: 8787, version: "0.4.0", startedAt: Date.now() };

test("the three verbs parse", () => {
  expect(parseArgs(["start"]).command).toBe("start");
  expect(parseArgs(["stop"]).command).toBe("stop");
  expect(parseArgs(["status"]).command).toBe("status");
  expect(parseArgs(["stop", "--force"]).flags.has("--force")).toBe(true);
});

test("status exits 1 and says so when nothing is running", async () => {
  const out: string[] = [];
  const code = await runStatus({ dir: await dir(), probe: probe(false, null), log: (l) => out.push(l) });
  expect(code).toBe(1);
  expect(out.join(" ")).toContain("not running");
});

test("status exits 0 and reports pid, port and version when running", async () => {
  const d = await dir();
  await writeState(d, s);
  const out: string[] = [];
  const code = await runStatus({ dir: d, probe: probe(true, "paddock"), log: (l) => out.push(l) });
  expect(code).toBe(0);
  const line = out.join(" ");
  expect(line).toContain("4242");
  expect(line).toContain("8787");
  expect(line).toContain("0.4.0");
});

test("a stale file is reported as stale, not silently as absence", async () => {
  // A crash left evidence; saying only "not running" throws it away.
  const d = await dir();
  await writeState(d, s);
  const out: string[] = [];
  const code = await runStatus({ dir: d, probe: probe(false, null), log: (l) => out.push(l) });
  expect(code).toBe(1);
  expect(out.join(" ").toLowerCase()).toContain("stale");
});

test("a recycled pid is reported as such and names the real command", async () => {
  const d = await dir();
  await writeState(d, s);
  const out: string[] = [];
  const code = await runStatus({
    dir: d, probe: probe(true, "/usr/bin/postgres -D /var/lib/pg"), log: (l) => out.push(l),
  });
  expect(code).toBe(1);
  expect(out.join(" ")).toContain("postgres");
});
```

- [ ] **Step 2: Run and watch fail**

Run: `bun test tests/lifecycle-status.test.ts`
Expected: FAIL — `@server/lifecycle/commands` does not exist and the verbs do not parse.

- [ ] **Step 3: Add the verbs**

In `src/server/cli.ts`, extend the type and the recogniser, and add usage lines:

```ts
export type Command =
  | "serve" | "update" | "start" | "stop" | "status" | "agent" | "hub" | "unknown";
```

```ts
export const USAGE = [
  "usage: paddock [--demo]          start the dashboard in the foreground",
  "       paddock start             start it detached; survives this terminal",
  "       paddock stop [--force]    stop the detached instance",
  "       paddock status            is it running?",
  "       paddock update [--check]  install the latest release",
  "       paddock --version | -V    print the version",
].join("\n");
```

```ts
function commandFor(verb: string | null): Command {
  if (verb === null) return "serve";
  if (verb === "serve" || verb === "update") return verb;
  if (verb === "start" || verb === "stop" || verb === "status") return verb;
  if (RESERVED.has(verb)) return verb as Command;
  return "unknown";
}
```

- [ ] **Step 4: Implement `runStatus`**

Create `src/server/lifecycle/commands.ts`:

```ts
import { checkState, removeState, type Probe } from "@server/lifecycle/state";

export interface StatusOpts {
  dir: string;
  probe?: Probe;
  log?: (line: string) => void;
  now?: () => number;
}

function uptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Exit code: 0 running, 1 not. That is what makes it usable from a script. */
export async function runStatus(o: StatusOpts): Promise<number> {
  const log = o.log ?? console.log;
  const now = (o.now ?? Date.now)();
  const got = await checkState(o.dir, o.probe);

  switch (got.kind) {
    case "none":
      log("paddock — not running");
      return 1;
    case "stale":
      // Say it once. A crash left this behind and silently tidying it up hides
      // that anything happened.
      log(`paddock — not running (stale state for pid ${got.state.pid}, cleared)`);
      await removeState(o.dir);
      return 1;
    case "mismatch":
      log(`paddock — not running (pid ${got.state.pid} is now: ${got.actual ?? "unknown"})`);
      await removeState(o.dir);
      return 1;
    case "running":
      log(
        `paddock ${got.state.version} — running ` +
          `(pid ${got.state.pid}, port ${got.state.port}, up ${uptime(now - got.state.startedAt)})`,
      );
      return 0;
  }
}
```

- [ ] **Step 5: Dispatch it**

In `src/server/index.ts`, beside the existing `command === "update"` branch:

```ts
if (command === "status") {
  process.exit(await runStatus({ dir: defaultConfigDir() }));
}
```

This must sit before any server setup — `status` should not open a herdr socket
or bind a port.

- [ ] **Step 6: Run the tests**

Run: `bun test tests/lifecycle-status.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Prove they can fail**

Make the `mismatch` case fall through to `running` — the recycled-pid test must
go RED. Restore it.

- [ ] **Step 8: Commit**

```bash
make check && make check-clean && make test
git add src/server/cli.ts src/server/lifecycle/commands.ts src/server/index.ts tests/lifecycle-status.test.ts
git commit -m "feat: paddock status, and the start/stop/status verbs

Exit 0 running, 1 not, which is the only reason a status subcommand beats ps.
A stale file and a recycled pid are reported distinctly rather than collapsed
into 'not running' — a crash left evidence, and a pid that now belongs to
something else is the case stop must never act on."
```

---

### Task 4: `paddock stop`

**Files:**
- Modify: `src/server/lifecycle/commands.ts`, `src/server/index.ts`
- Test: `tests/lifecycle-stop.test.ts`

**Interfaces:**
- Consumes: `checkState`, `removeState`, `Probe` (Task 1).
- Produces: `runStop(opts: { dir: string; force?: boolean; probe?: Probe; log?; signal?: (pid: number, sig: NodeJS.Signals) => void; waitMs?: number }): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lifecycle-stop.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStop } from "@server/lifecycle/commands";
import { writeState, type Probe } from "@server/lifecycle/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-stop-"));
const s = { pid: 4242, args: "paddock", port: 8787, version: "0.4.0", startedAt: Date.now() };

/** Alive until the Nth liveness check, then dead — models a process obeying SIGTERM. */
function dyingProbe(afterChecks: number, args: string): { probe: Probe } {
  let n = 0;
  return { probe: { isAlive: () => ++n <= afterChecks, argsOf: () => args } };
}

test("stop on a recycled pid REFUSES to signal it", async () => {
  // The worst outcome this feature can produce is killing someone else's
  // process. Nothing may be signalled unless the args still match.
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const code = await runStop({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => "/usr/bin/postgres -D /var/lib/pg" },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: () => {},
  });
  expect(sent, "a signal was sent to a process that is not paddock").toEqual([]);
  expect(code).not.toBe(0);
});

test("stop signals SIGTERM and reports success once it exits", async () => {
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const { probe } = dyingProbe(1, "paddock");
  const code = await runStop({
    dir: d, probe, signal: (pid, sig) => sent.push(`${sig}->${pid}`), log: () => {}, waitMs: 500,
  });
  expect(sent).toEqual(["SIGTERM->4242"]);
  expect(code).toBe(0);
});

test("a process that will not die is reported, and is NOT killed automatically", async () => {
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const out: string[] = [];
  const code = await runStop({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => "paddock" },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: (l) => out.push(l),
    waitMs: 300,
  });
  expect(sent).toEqual(["SIGTERM->4242"]);
  expect(out.join(" ")).toContain("--force");
  expect(code).not.toBe(0);
});

test("--force escalates to SIGKILL, and only then", async () => {
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const code = await runStop({
    dir: d,
    force: true,
    probe: { isAlive: () => true, argsOf: () => "paddock" },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: () => {},
    waitMs: 300,
  });
  expect(sent).toEqual(["SIGTERM->4242", "SIGKILL->4242"]);
  expect(code).toBe(0);
});

test("stop with nothing running is not an error", async () => {
  const code = await runStop({
    dir: await dir(), probe: { isAlive: () => false, argsOf: () => null },
    signal: () => { throw new Error("must not signal"); }, log: () => {},
  });
  expect(code).toBe(0);
});
```

- [ ] **Step 2: Run and watch fail**

Run: `bun test tests/lifecycle-stop.test.ts`
Expected: FAIL — `runStop` is not exported.

- [ ] **Step 3: Implement**

Append to `src/server/lifecycle/commands.ts`:

```ts
export interface StopOpts {
  dir: string;
  force?: boolean;
  probe?: Probe;
  log?: (line: string) => void;
  /** Injected so a test can assert what would have been signalled. */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  waitMs?: number;
}

const sendSignal = (pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); };

export async function runStop(o: StopOpts): Promise<number> {
  const log = o.log ?? console.log;
  const send = o.signal ?? sendSignal;
  const probe = o.probe;
  const waitMs = o.waitMs ?? 10_000;
  const got = await checkState(o.dir, probe);

  if (got.kind === "none") { log("paddock — not running"); return 0; }
  if (got.kind === "stale") {
    log(`paddock — not running (stale state for pid ${got.state.pid}, cleared)`);
    await removeState(o.dir);
    return 0;
  }
  if (got.kind === "mismatch") {
    // Refuse. This is the whole reason the state file carries more than a pid.
    log(`paddock: pid ${got.state.pid} is not paddock any more — refusing to signal it`);
    log(`  it is now: ${got.actual ?? "unknown"}`);
    await removeState(o.dir);
    return 1;
  }

  const { pid } = got.state;
  send(pid, "SIGTERM");
  const deadline = Date.now() + waitMs;
  const alive = () => (probe ?? systemProbe).isAlive(pid);
  while (Date.now() < deadline) {
    if (!alive()) {
      log(`paddock: stopped (pid ${pid})`);
      await removeState(o.dir);
      return 0;
    }
    await Bun.sleep(100);
  }

  if (!o.force) {
    // Never escalate on its own. A process refusing to leave is the operator's
    // call, not a decision to make silently on their behalf.
    log(`paddock: pid ${pid} did not exit after SIGTERM`);
    log("  run 'paddock stop --force' to send SIGKILL");
    return 1;
  }
  send(pid, "SIGKILL");
  log(`paddock: killed (pid ${pid})`);
  await removeState(o.dir);
  return 0;
}
```

Add `systemProbe` to the existing import from `@server/lifecycle/state`.

- [ ] **Step 4: Dispatch it**

In `src/server/index.ts`, beside the `status` branch:

```ts
if (command === "stop") {
  process.exit(await runStop({ dir: defaultConfigDir(), force: flags.has("--force") }));
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/lifecycle-stop.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Prove they can fail**

Delete the `mismatch` branch so it falls through to the signal — the
refuses-to-signal test must go RED with a `SIGTERM` recorded. Restore it. Then
make the non-force path send `SIGKILL` anyway; the "not killed automatically"
test must go RED.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && make test
git add src/server/lifecycle/commands.ts src/server/index.ts tests/lifecycle-stop.test.ts
git commit -m "feat: paddock stop, which refuses rather than guesses

Nothing is signalled unless the pid is alive AND still running the same command
the state file recorded. A recycled pid is reported and left alone; the test
that matters asserts no signal was sent at all.

SIGKILL is never automatic. A process refusing SIGTERM is the operator's call."
```

---

### Task 5: `paddock start`

**Files:**
- Modify: `src/server/lifecycle/commands.ts`, `src/server/index.ts`
- Test: `tests/lifecycle-start.test.ts`

**Interfaces:**
- Consumes: `checkState` (Task 1), `runStatus`/`runStop` conventions (Tasks 3–4).
- Produces: `childCommand(): string[]`; `runStart(opts): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/lifecycle-start.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childCommand, runStart } from "@server/lifecycle/commands";
import { stateFile, writeState, type Probe } from "@server/lifecycle/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-start-"));

test("the child command re-invokes this build, not a guess at it", () => {
  // Under `bun src/...` argv[1] is the script; in a compiled binary it is
  // /$bunfs/root/... and must NOT be passed on — the executable is self-contained.
  const cmd = childCommand();
  expect(cmd.length).toBeGreaterThan(0);
  expect(cmd[0]).toBe(process.execPath);
  expect(cmd.some((a) => a.startsWith("/$bunfs/"))).toBe(false);
});

test("start refuses when one is already running, and does not spawn", async () => {
  const d = await dir();
  await writeState(d, { pid: 4242, args: "paddock", port: 8787, version: "0.4.0", startedAt: Date.now() });
  const probe: Probe = { isAlive: () => true, argsOf: () => "paddock" };
  let spawned = 0;
  const out: string[] = [];
  const code = await runStart({
    dir: d, probe, log: (l) => out.push(l), spawn: () => { spawned++; return { pid: 1, exited: new Promise(() => {}) }; },
  });
  expect(spawned).toBe(0);
  expect(code).not.toBe(0);
  expect(out.join(" ")).toContain("4242");
});

test("a detached child that binds is reported as started", async () => {
  const d = await dir();
  const code = await runStart({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => "paddock" },
    log: () => {},
    waitMs: 3000,
    spawn: () => {
      // Model a child that writes its state shortly after being spawned.
      void (async () => {
        await Bun.sleep(50);
        await writeState(d, { pid: 777, args: "paddock", port: 8787, version: "0.4.0", startedAt: Date.now() });
      })();
      return { pid: 777, exited: new Promise(() => {}) };
    },
    healthCheck: async () => true,
  });
  expect(code).toBe(0);
  expect(JSON.parse(await readFile(stateFile(d), "utf8")).pid).toBe(777);
});

test("a child that exits before binding fails loudly and surfaces the log", async () => {
  const d = await dir();
  const out: string[] = [];
  const code = await runStart({
    dir: d,
    probe: { isAlive: () => false, argsOf: () => null },
    log: (l) => out.push(l),
    waitMs: 3000,
    logTail: async () => "Error: port 8787 already in use",
    spawn: () => ({ pid: 778, exited: Promise.resolve(1) }),
    healthCheck: async () => false,
  });
  expect(code).not.toBe(0);
  expect(out.join(" ")).toContain("already in use");
}, 15_000);
```

- [ ] **Step 2: Run and watch fail**

Run: `bun test tests/lifecycle-start.test.ts`
Expected: FAIL — `childCommand` and `runStart` are not exported.

- [ ] **Step 3: Implement**

Append to `src/server/lifecycle/commands.ts`:

```ts
import { join } from "node:path";
import { open, readFile } from "node:fs/promises";

/**
 * How to re-invoke this exact build, detached.
 *
 * A compiled binary is self-contained: `process.execPath` is the whole command,
 * and `Bun.argv[1]` is the in-binary path `/$bunfs/root/...`, which must never
 * be passed on. Under `bun src/server/index.ts`, `execPath` is bun and the
 * script path IS needed.
 */
export function childCommand(): string[] {
  const script = Bun.argv[1];
  const compiled = script === undefined || script.startsWith("/$bunfs/");
  return compiled ? [process.execPath] : [process.execPath, script];
}

export interface StartOpts {
  dir: string;
  probe?: Probe;
  log?: (line: string) => void;
  waitMs?: number;
  spawn?: () => { pid: number; exited: Promise<number> };
  healthCheck?: (port: number) => Promise<boolean>;
  logTail?: () => Promise<string>;
}

export function logFile(dir: string): string {
  return join(dir, "paddock.log");
}

export async function runStart(o: StartOpts): Promise<number> {
  const log = o.log ?? console.log;
  const waitMs = o.waitMs ?? 10_000;
  const existing = await checkState(o.dir, o.probe);
  if (existing.kind === "running") {
    log(`paddock: already running (pid ${existing.state.pid}, port ${existing.state.port})`);
    return 1;
  }
  if (existing.kind === "mismatch") {
    log(`paddock: pid ${existing.state.pid} is not paddock any more — clearing stale state`);
    await removeState(o.dir);
  }

  const child = o.spawn ? o.spawn() : await spawnDetached(o.dir);
  const deadline = Date.now() + waitMs;
  let childGone = false;
  void child.exited.then(() => { childGone = true; });

  const health = o.healthCheck ?? defaultHealthCheck;
  while (Date.now() < deadline) {
    const got = await checkState(o.dir, o.probe);
    if (got.kind === "running" && (await health(got.state.port))) {
      log(`paddock: started (pid ${got.state.pid}, port ${got.state.port})`);
      return 0;
    }
    // An early exit is a failure now, not in ten seconds' time.
    if (childGone) break;
    await Bun.sleep(100);
  }

  const tail = o.logTail ? await o.logTail() : await readLogTail(o.dir);
  log("paddock: the detached process did not start");
  if (tail.trim() !== "") log(tail.trim());
  log(`  full log: ${logFile(o.dir)}`);
  return 1;
}

async function spawnDetached(dir: string): Promise<{ pid: number; exited: Promise<number> }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Truncated, not appended: an unrotated log that only grows is a slow bug,
  // and one run's output is the useful scope.
  const fh = await open(logFile(dir), "w", 0o600);
  const p = Bun.spawn(childCommand(), {
    stdio: ["ignore", fh.fd, fh.fd],
    env: process.env,
  });
  p.unref?.();
  return { pid: p.pid, exited: p.exited };
}

async function defaultHealthCheck(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    return r.ok;
  } catch {
    // Not up yet is the ordinary case while polling, not an error to report.
    return false;
  }
}

async function readLogTail(dir: string): Promise<string> {
  try {
    const text = await readFile(logFile(dir), "utf8");
    return text.split("\n").slice(-15).join("\n");
  } catch {
    return "";
  }
}
```

Add `mkdir` to the `node:fs/promises` import.

- [ ] **Step 4: Dispatch it**

In `src/server/index.ts`:

```ts
if (command === "start") {
  process.exit(await runStart({ dir: defaultConfigDir() }));
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/lifecycle-start.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Prove they can fail**

Make `childCommand` always return `[process.execPath, Bun.argv[1]]` — the
first test must go RED under a compiled build. Then remove the `childGone`
early-exit break; the last test must take the full timeout instead of failing
fast, which the 15s budget will expose.

- [ ] **Step 7: End-to-end check, by hand, recorded in the report**

```bash
make build
./paddock start && ./paddock status && ./paddock stop && ./paddock status
```

Expected: started → running with a pid → stopped → not running, exit 1.

- [ ] **Step 8: Commit**

```bash
make check && make check-clean && make test
git add src/server/lifecycle/commands.ts src/server/index.ts tests/lifecycle-start.test.ts
git commit -m "feat: paddock start, detached, and only reported once it serves

Waits for the state file AND a health response before claiming success, because
reporting success and letting the operator find the port conflict later is the
failure this command exists to prevent. A child that exits early fails
immediately rather than waiting out the timeout, and its log tail is printed.

childCommand does not pass Bun.argv[1] for a compiled build: it is
/\$bunfs/root/... inside the binary, and the executable is self-contained."
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`, `docs/running-locally.md`, `docs/architecture.md`

- [ ] **Step 1: README**

In the install block, replace the single `ctrl+c` sentence with the fuller
lifecycle, keeping it to four lines:

```markdown
`ctrl+c` stops it. To keep it running after you close the terminal:

```bash
paddock start     # detached
paddock status    # is it up?
paddock stop
```
```

- [ ] **Step 2: `docs/running-locally.md`**

Add a short section explaining that a phone-facing paddock has to outlive the
terminal, so `paddock start` is the normal way to run it once a tunnel is in
front; note the log at `~/.config/paddock/paddock.log` is truncated per start,
and that a service manager is the right answer for restart-on-boot.

- [ ] **Step 3: `docs/architecture.md`**

Add `lifecycle/` to the module list: `state.ts` owns the file and the identity
check, `commands.ts` owns the three verbs, and neither is imported by anything
in the request path. Record why identity comes from `ps` rather than `Bun.argv`,
with the measurement.

- [ ] **Step 4: Commit**

```bash
make check && make check-clean && make test
git add README.md docs/running-locally.md docs/architecture.md
git commit -m "docs: how to run paddock detached, and why identity comes from ps"
```

---

## Self-review

**Spec coverage.** Command surface → Tasks 3–5; state file shape, location and
atomic write → Task 1; "every running paddock writes it" → Task 2; the
stale-PID hazard → Task 1's `checkState` and Task 4's refusal; `start`'s
double-poll → Task 5; `stop`'s timeout and `--force` → Task 4; `status` exit
codes → Task 3; the log's truncate-per-start → Task 5; docs → Task 6.

**Placeholders.** None. Every code step carries real code.

**Type consistency.** `PaddockState`, `Probe` and `StateCheck` (Task 1) are
consumed unchanged by Tasks 3–5. `runStatus`/`runStop`/`runStart` all return
`Promise<number>` and all take `{ dir, probe?, log? }`, so `index.ts` dispatches
them identically. `capturedArgs` is the only producer of the `args` string, at
both ends.

**Two risks worth stating.** Task 5's tests inject `spawn`, so the *real*
detach path is exercised only by the by-hand check in Step 7 — that check is
not optional, and if it is skipped the feature ships unproven. And identity
resolution has two implementations — `/proc` on Linux, `ps` on macOS — so the
macOS path is exercised by no test in CI, which runs on Linux. That is the same
blind spot that let the `mktemp` bug reach review on the previous branch; the
test below asserts `capturedArgs` agrees with `ps` wherever both exist, which
is the strongest check available without a macOS runner.
