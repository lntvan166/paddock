import { glyph, say } from "@server/term";
import { systemProbe, type Probe } from "@server/lifecycle/state";
import { checkTunnelState, removeTunnelState, tunnelStateFile } from "@server/tunnel/state";

export interface StopTunnelOpts {
  dir: string;
  probe?: Probe;
  log?: (line: string) => void;
  /** Injected so a test can assert what would have been signalled. */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  waitMs?: number;
}

/**
 * Stop a running tunnel.
 *
 * SIGTERM ONLY, AND NEVER SIGKILL. This is not a simplified copy of `runStop`;
 * it is a deliberately different policy, and the difference is the reason this
 * function exists separately.
 *
 * A tunnel process owns a `cloudflared` CHILD, and its registered teardown is
 * the only thing that reaps it — see the long note on `registerShutdown` in
 * `tunnel/run.ts`. SIGKILL cannot be handled, so it would skip that teardown
 * and leave cloudflared running with a public URL still resolving and nothing
 * behind it that anyone is watching. That is the worst failure this feature
 * has, and it is invisible from the terminal that just returned to a prompt.
 * So a tunnel that will not exit is REPORTED, with its pid, and never escalated
 * to a signal that would cause the exact outcome stopping it is meant to avoid.
 *
 * The identity discipline is `runStop`'s and is not relaxed: a pid that is
 * alive but no longer running the recorded command line is refused, because
 * killing an unrelated process that inherited the number is the worst thing
 * either stop path can do.
 */
export interface StopTunnelResult {
  code: number;
  /**
   * A tunnel that was SERVING THE DASHBOARD ITSELF was just stopped.
   *
   * `paddock stop` needs this to avoid contradicting itself. A plain
   * `paddock tunnel` records both files, and its own shutdown clears the
   * paddock record — so by the time the paddock half of `stop` looks, the
   * record is gone and it would report "paddock — not running" about the very
   * process it just stopped.
   */
  stoppedServing: boolean;
}

export async function stopTunnel(o: StopTunnelOpts): Promise<StopTunnelResult> {
  const log = o.log ?? say;
  const probe = o.probe ?? systemProbe;
  const send = o.signal ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); });
  const waitMs = o.waitMs ?? 10_000;

  const got = await checkTunnelState(o.dir, probe, log);
  switch (got.kind) {
    case "none":
      // Silent success. `paddock stop` calls this on every run, and most have
      // no tunnel; a "no tunnel was running" line on all of them is noise.
      return { code: 0, stoppedServing: false };
    case "unreadable":
      log(
        `paddock: could not read the tunnel's state (${got.error}), refusing to guess — ` +
          "nothing signalled",
      );
      return { code: 1, stoppedServing: false };
    case "stale":
      log(`paddock: tunnel not running (stale record for pid ${got.state.pid}, cleared)`);
      await clear(o.dir, log);
      return { code: 0, stoppedServing: false };
    case "mismatch":
      log(`paddock: pid ${got.state.pid} is not the tunnel any more — refusing to signal it`);
      log(`  it is now: ${got.actual ?? "unknown"}`);
      await clear(o.dir, log);
      return { code: 1, stoppedServing: false };
    case "running":
      break;
    default: {
      const _exhaustive: never = got;
      throw new Error(`paddock: unhandled tunnel state: ${JSON.stringify(_exhaustive)}`);
    }
  }

  const { pid, args } = got.state;
  try {
    send(pid, "SIGTERM");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      log(`paddock: the tunnel (pid ${pid}) was already gone`);
      await clear(o.dir, log);
      return { code: 0, stoppedServing: false };
    }
    if (code === "EPERM") {
      log(`paddock: cannot signal the tunnel (pid ${pid}) — permission denied`);
      return { code: 1, stoppedServing: false };
    }
    throw e;
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!probe.isAlive(pid)) {
      // Its own teardown removes the record and the socket. Cleared here too,
      // for the case where it could not: a record outliving its process is a
      // tunnel `pair` would report as stale for ever.
      log(`${glyph("yes")} tunnel stopped (pid ${pid})`);
      await clear(o.dir, log);
      return { code: 0, stoppedServing: got.state.publishing === null };
    }
    const actual = probe.argsOf(pid);
    if (actual !== null && actual !== args) {
      log(`paddock: pid ${pid} is not the tunnel any more — refusing to signal it`);
      log(`  it is now: ${actual}`);
      await clear(o.dir, log);
      return { code: 1, stoppedServing: false };
    }
    // `actual === null` is "cannot tell", not "someone else": a process being
    // reaped reads as an empty cmdline while `kill(pid, 0)` still succeeds.
    // Conclude nothing and keep polling — `runStop` makes the same call, and
    // for the same reason.
    await Bun.sleep(100);
  }

  // NO --force PATH, deliberately. See the note on this function.
  log(`paddock: the tunnel (pid ${pid}) did not exit after SIGTERM`);
  log("  it is left running: SIGKILL would skip the teardown that closes");
  log("  cloudflared, leaving a public URL up with nothing behind it.");
  log(`  check it with \`paddock pair\`, or signal pid ${pid} by hand.`);
  return { code: 1, stoppedServing: false };
}

async function clear(dir: string, log: (line: string) => void): Promise<void> {
  try {
    await removeTunnelState(dir);
  } catch (e) {
    log(
      `paddock: could not remove ${tunnelStateFile(dir)} (${(e as Error).message}) ` +
        "— remove it by hand, or the next run will read it again",
    );
  }
}
