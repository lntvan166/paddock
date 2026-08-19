import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkState, removeState, systemProbe, type Probe } from "@server/lifecycle/state";

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
    case "unreadable":
      // Distinct from "none" on purpose: "I could not read the state" and
      // "nothing is running" are different facts, and reporting the first as
      // the second is the guess this module refuses to make. The file is
      // left in place — we could not even read it, so deleting it would
      // destroy the one clue an operator has. Exit non-zero: this is not a
      // confirmed "not running", it is "don't know", which must not look
      // like success to a caller scripting on the exit code.
      log(`paddock — could not read state (${got.error})`);
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

type SignalOutcome = "ok" | "gone" | "denied";

/**
 * Wraps the (possibly injected) signal function so a thrown `process.kill`
 * error becomes a labelled outcome instead of an unhandled stack trace.
 *
 * ESRCH means the pid exited in the gap between our last liveness check and
 * this call — already gone, not a failure. EPERM is genuinely reachable:
 * `systemProbe.isAlive` deliberately treats EPERM as "alive" (see state.ts),
 * and `/proc/<pid>/cmdline` is world-readable, so a paddock started under
 * another uid can reach `running` here and then fail to be signalled. Any
 * other error is a real failure and must not be swallowed.
 */
function trySignal(
  send: (pid: number, sig: NodeJS.Signals) => void,
  pid: number,
  sig: NodeJS.Signals,
): SignalOutcome {
  try {
    send(pid, sig);
    return "ok";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "denied";
    throw e;
  }
}

export async function runStop(o: StopOpts): Promise<number> {
  const log = o.log ?? console.log;
  const send = o.signal ?? sendSignal;
  const probe = o.probe ?? systemProbe;
  const waitMs = o.waitMs ?? 10_000;
  const got = await checkState(o.dir, probe);

  switch (got.kind) {
    case "none":
      log("paddock — not running");
      return 0;
    case "unreadable":
      // Distinct from "none" on purpose, same reasoning as runStatus: "could
      // not read the state" and "nothing is running" are different facts.
      // This is exactly the case where guessing is forbidden — we cannot
      // tell whether something is running, so refuse, send no signal, and
      // leave the file in place rather than destroy the one clue an
      // operator has.
      log(`paddock — could not read state (${got.error}), refusing to guess — nothing signalled`);
      return 1;
    case "stale":
      log(`paddock — not running (stale state for pid ${got.state.pid}, cleared)`);
      await removeState(o.dir);
      return 0;
    case "mismatch":
      // Refuse. This is the whole reason the state file carries more than a
      // pid: killing someone else's process is the worst outcome this
      // feature can produce.
      log(`paddock: pid ${got.state.pid} is not paddock any more — refusing to signal it`);
      log(`  it is now: ${got.actual ?? "unknown"}`);
      await removeState(o.dir);
      return 1;
    case "running":
      break;
  }

  const { pid, args } = got.state;

  const term = trySignal(send, pid, "SIGTERM");
  if (term === "gone") {
    log(`paddock: pid ${pid} was already gone — nothing to stop`);
    await removeState(o.dir);
    return 0;
  }
  if (term === "denied") {
    log(`paddock: cannot signal pid ${pid} — permission denied (started by another user?)`);
    return 1;
  }

  /**
   * Alive AND still running the exact command line the state file recorded
   * — checkState's own identity check, applied again after the signal. A
   * pid that stays alive but stops matching means paddock has already
   * exited and the kernel handed the number to an unrelated process while
   * we were waiting: escalating to SIGKILL against that would be the exact
   * hazard this feature exists to prevent, just ten seconds later and with
   * a signal that cannot be blocked. `isAlive` alone (the mutated version
   * this guards against) cannot tell the two apart.
   */
  const stillOurs = () => probe.isAlive(pid) && probe.argsOf(pid) === args;

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!probe.isAlive(pid)) {
      log(`paddock: stopped (pid ${pid})`);
      await removeState(o.dir);
      return 0;
    }
    if (!stillOurs()) {
      // Our SIGTERM worked; the pid was recycled onto something else while
      // we were watching for it to die. Nothing further to signal — this is
      // success, not a timeout.
      const actual = probe.argsOf(pid);
      log(
        `paddock: pid ${pid} is no longer paddock (now: ${actual ?? "unknown"}) ` +
          "— already gone, nothing further to do",
      );
      await removeState(o.dir);
      return 0;
    }
    await Bun.sleep(100);
  }

  if (!o.force) {
    // Never escalate on its own. A process refusing to leave is the
    // operator's call, not a decision to make silently on their behalf.
    log(`paddock: pid ${pid} did not exit after SIGTERM`);
    log("  run 'paddock stop --force' to send SIGKILL");
    return 1;
  }

  // One more identity check, immediately before the signal that cannot be
  // blocked. The loop above samples every 100ms; a recycle landing in the
  // gap between its last check and here must not reach `send`.
  if (!stillOurs()) {
    const actual = probe.argsOf(pid);
    log(`paddock: pid ${pid} is not paddock any more — refusing to send SIGKILL`);
    log(`  it is now: ${actual ?? "unknown"}`);
    await removeState(o.dir);
    return 1;
  }

  const kill = trySignal(send, pid, "SIGKILL");
  if (kill === "gone") {
    log(`paddock: pid ${pid} was already gone — nothing to kill`);
    await removeState(o.dir);
    return 0;
  }
  if (kill === "denied") {
    log(`paddock: cannot signal pid ${pid} — permission denied (started by another user?)`);
    return 1;
  }
  log(`paddock: killed (pid ${pid})`);
  await removeState(o.dir);
  return 0;
}

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

/**
 * Success is only reported once the new instance is actually serving: the
 * state file has appeared AND a health request against its port answered.
 * Reporting success from the state file alone and letting the operator
 * discover a port conflict later is exactly the failure this command exists
 * to prevent.
 */
export async function runStart(o: StartOpts): Promise<number> {
  const log = o.log ?? console.log;
  const waitMs = o.waitMs ?? 10_000;
  const existing = await checkState(o.dir, o.probe);

  switch (existing.kind) {
    case "unreadable":
      // Same reasoning as runStatus/runStop: an I/O error reading the state
      // file is "cannot tell", not "nothing running". Guessing the latter
      // would let this spawn a second paddock right alongside one already
      // serving — the exact guess this module refuses to make.
      log(`paddock: could not read state (${existing.error}), refusing to guess — not starting`);
      return 1;
    case "running":
      log(`paddock: already running (pid ${existing.state.pid}, port ${existing.state.port})`);
      return 1;
    case "mismatch":
      log(`paddock: pid ${existing.state.pid} is not paddock any more — clearing stale state`);
      await removeState(o.dir);
      break;
    case "stale":
      // A crash left this behind. Cleared deliberately, before spawning: left
      // in place, the poll loop below would keep reading the dead instance's
      // own (still "running"-shaped, once it were alive again) file until the
      // new child happened to overwrite it with its own — working by
      // accident, not by design.
      log(`paddock: clearing stale state for pid ${existing.state.pid}`);
      await removeState(o.dir);
      break;
    case "none":
      break;
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
  try {
    const p = Bun.spawn(childCommand(), {
      stdio: ["ignore", fh.fd, fh.fd],
      env: process.env,
    });
    p.unref?.();
    return { pid: p.pid, exited: p.exited };
  } finally {
    // The parent has no further use for this handle — the child inherited
    // its own copy of the fd across spawn. Holding it open here would just
    // be a leaked descriptor for the lifetime of this (short-lived) process.
    await fh.close();
  }
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
