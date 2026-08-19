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

export async function runStop(o: StopOpts): Promise<number> {
  const log = o.log ?? console.log;
  const send = o.signal ?? sendSignal;
  const probe = o.probe;
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
    // Never escalate on its own. A process refusing to leave is the
    // operator's call, not a decision to make silently on their behalf.
    log(`paddock: pid ${pid} did not exit after SIGTERM`);
    log("  run 'paddock stop --force' to send SIGKILL");
    return 1;
  }
  send(pid, "SIGKILL");
  log(`paddock: killed (pid ${pid})`);
  await removeState(o.dir);
  return 0;
}
