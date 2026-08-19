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
