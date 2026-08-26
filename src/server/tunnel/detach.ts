import { glyph, say } from "@server/term";
import {
  ConfigDirUnusable, logFile, readLogTail, spawnDetached,
} from "@server/lifecycle/commands";
import type { Probe } from "@server/lifecycle/state";
import { askControl, type Ask } from "@server/tunnel/control";
import { runPair } from "@server/tunnel/pair";
import { checkTunnelState, removeTunnelState } from "@server/tunnel/state";

export interface DetachOpts {
  dir: string;
  probe?: Probe;
  log?: (line: string) => void;
  waitMs?: number;
  spawn?: () => { pid: number; exited: Promise<number> };
  ask?: (socket: string) => Promise<Ask>;
  logTail?: () => Promise<string>;
  now?: () => number;
  colour?: boolean;
  columns?: number;
  rows?: number;
  /** `--for` as typed, forwarded to the child verbatim. */
  forSpec?: string;
  publishRunning?: boolean;
}

/**
 * `paddock tunnel --detach` — publish, then give the terminal back.
 *
 * The mode paddock is actually for. A tunnel exists so a phone can reach the
 * dashboard while the work runs, and the foreground form makes the one
 * component you need while away from the machine the one that requires you to
 * stay at it.
 *
 * SUCCESS IS NOT A SUCCESSFUL SPAWN. It is a child that published a URL, wrote
 * its record, and answers on its control socket — `runStart`'s rule, for the
 * same reason: reporting success from the spawn alone and letting the operator
 * discover a dead tunnel later is exactly what this command exists to prevent.
 * A public URL nobody is serving is worse than a refusal at the terminal.
 */
export async function runDetach(o: DetachOpts): Promise<number> {
  const log = o.log ?? say;
  const ask = o.ask ?? askControl;
  const waitMs = o.waitMs ?? 30_000;

  const existing = await checkTunnelState(o.dir, o.probe, log);
  switch (existing.kind) {
    case "unreadable":
      // "Cannot tell" is not "nothing running". Guessing the latter would
      // detach a second tunnel beside one already publishing.
      log(`paddock: could not read the tunnel's state (${existing.error}), refusing to guess`);
      return 1;
    case "running":
      log(`paddock: a tunnel is already running (pid ${existing.state.pid})`);
      log(`    ${existing.state.url}`);
      log("    `paddock pair` for its code, or `paddock stop` to close it");
      return 1;
    case "stale":
      log(`paddock: clearing a stale tunnel record for pid ${existing.state.pid}`);
      await removeTunnelState(o.dir);
      break;
    case "mismatch":
      log(`paddock: pid ${existing.state.pid} is not a tunnel any more — clearing its record`);
      await removeTunnelState(o.dir);
      break;
    case "none":
      break;
    default: {
      const _exhaustive: never = existing;
      throw new Error(`paddock: unhandled tunnel state: ${JSON.stringify(_exhaustive)}`);
    }
  }

  let child: { pid: number; exited: Promise<number> };
  try {
    child = o.spawn
      ? o.spawn()
      : await spawnDetached(o.dir, {
          tunnel: { for: o.forSpec, publishRunning: o.publishRunning },
        });
  } catch (e) {
    // Same narrow guard as `runStart`: only the log-file preparation becomes a
    // refusal, so an unexpected failure inside Bun.spawn still surfaces loudly
    // rather than being reported as a permissions problem it is not.
    if (!(e instanceof ConfigDirUnusable)) throw e;
    log(`paddock: cannot write ${e.file} (${e.reason}) — not starting a tunnel`);
    return 1;
  }

  let childGone = false;
  void child.exited.then(() => { childGone = true; });

  // Poll for the child to become FINDABLE AND ANSWERING. Both, because either
  // alone is a tunnel the operator cannot use: a record without a socket is a
  // code nobody can read, and a socket is what proves the process got as far
  // as publishing a URL.
  const deadline = Date.now() + waitMs;
  for (;;) {
    const got = await checkTunnelState(o.dir, o.probe, () => {});
    if (got.kind === "running" && (await ask(got.state.control)).ok) break;

    if (childGone) {
      // Never swallowed, and never reported as a timeout: a child that DIED is
      // a different fact from one that is slow, and its own output is the only
      // place the reason exists.
      log(`${glyph("no")} the tunnel exited before it published anything`);
      const tail = await (o.logTail ?? (() => readLogTail(o.dir)))();
      if (tail.trim() !== "") log(tail);
      else log(`    nothing was written to ${logFile(o.dir)}`);
      await removeTunnelState(o.dir);
      return 1;
    }
    if (Date.now() > deadline) {
      // The child is still alive but has not published. Left running, it is a
      // cloudflared nobody is watching — the orphan failure this codebase
      // treats as its worst — so it is killed rather than abandoned.
      log(`${glyph("no")} the tunnel did not publish a URL within ${Math.round(waitMs / 1000)}s`);
      try {
        process.kill(child.pid, "SIGTERM");
        log(`    stopped pid ${child.pid} rather than leave it running unwatched`);
      } catch (e) {
        log(`    could not stop pid ${child.pid} (${String(e)}) — check it with \`paddock pair\``);
      }
      const tail = await (o.logTail ?? (() => readLogTail(o.dir)))();
      if (tail.trim() !== "") log(tail);
      return 1;
    }
    await Bun.sleep(150);
  }

  log(`${glyph("yes")} tunnel published in the background`);
  // Rendered by `runPair`, not transcribed here. Two renderings of the URL,
  // code, expiry and QR would be two things to keep in step, and the operator
  // will run `paddock pair` again later expecting the same block.
  const code = await runPair({
    dir: o.dir, probe: o.probe, log, ask: o.ask, now: o.now,
    colour: o.colour, columns: o.columns, rows: o.rows,
  });
  if (code === 0) log("    `paddock stop` closes it");
  return code;
}
