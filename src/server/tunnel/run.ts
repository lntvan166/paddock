import type { AgentStore } from "@server/state/store";
import type { Hub } from "@server/ws/hub";
import { hubWebSocket, tryUpgradeWs, type WsData } from "@server/ws/serve";
import {
  startTunnel as realStartTunnel,
  terminate,
  type Child,
  type Tunnel,
} from "@server/tunnel/cloudflared";
import { decide, gateResponse } from "@server/tunnel/gate";
import { errorCode } from "@server/startup-errors";
import type { Pairing } from "@server/tunnel/pairing";
import { human, render, useColour } from "@server/tunnel/display";

export interface TunnelDeps {
  app: { fetch(req: Request): Response | Promise<Response> };
  hub: Hub;
  hostId: string;
  store: AgentStore;
  pairing: Pairing;
  /** 0 lets the OS pick, which is what the tests use. */
  port: number;
  bin?: string;
  deadlineMs?: number | null;
  startTunnel?: typeof realStartTunnel;
  setPublicUrl?: (url: string | null) => void;
  /**
   * The environment and the terminal, injected for the same reason every clock
   * in this codebase is. Read from the real ones in production; a test that
   * read `process.stdout.isTTY` instead would, under a pty, emit
   * cursor-home-and-clear-screen writes that ERASE the test runner's own
   * output — hiding a failure printed above it.
   */
  env?: Record<string, string | undefined>;
  isTty?: boolean;
  /**
   * How this run's teardown reaches the ONE process-wide signal handler.
   *
   * `runTunnel` deliberately installs NO handler of its own — see the long
   * comment on the registration below. The caller (`src/server/index.ts`)
   * stores what it is given and awaits it from the handler it already has.
   *
   * The teardown resolves to whether it actually shut everything down, and the
   * caller turns a `false` into a non-zero exit status. See `teardown`.
   */
  registerShutdown?: (fn: () => Promise<boolean>) => void;
  now?: () => number;
}

/**
 * The second listener: the same app, plus the gate.
 *
 * The gate is applied HERE, at the socket, and NOT as Hono middleware, because
 * this function upgrades `/ws` before `app.fetch` is ever called — exactly as
 * `index.ts` does for the plain listener. A middleware could never see that
 * upgrade, so it would leave the WebSocket, and therefore every agent's live
 * output, ungated. This is the ONE enforcement point; there is deliberately no
 * second copy of the decision anywhere.
 *
 * `decide` returning a `Decision` rather than a `Response` is what lets that
 * single rule serve both shapes of request: the upgrade above, and the ordinary
 * request handed to `gateResponse` below. The refusal is rendered THERE and
 * never rebuilt here — a transcribed copy of its headers/page/401 block is how
 * two renderings of one refusal would come to disagree.
 */
export function serveGated(deps: TunnelDeps): { port: number; stop(): void } {
  const server = Bun.serve<WsData>({
    port: deps.port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const d = decide(req, (t) => deps.pairing.has(t));
      if (d.kind !== "pass") return gateResponse(d, req);

      // Past the gate, this listener serves EXACTLY what the plain one serves,
      // from one definition — see `ws/serve.ts`. `null` means the request is
      // not the socket route and belongs to the app.
      const ws = tryUpgradeWs(req, srv);
      if (ws !== null) return ws;
      return deps.app.fetch(req);
    },
    websocket: hubWebSocket({ hub: deps.hub, hostId: deps.hostId, store: deps.store }),
  });
  // Bun types `port` as optional — a unix-socket server has none. This one is
  // a TCP listener on loopback, so it always has one, and a missing port means
  // there is nothing for cloudflared to point at. Loud, never defaulted: a
  // fallback here would publish a tunnel to a port nothing is listening on.
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("paddock: the gated listener bound no port");
  }
  return { port, stop: () => server.stop(true) };
}

/**
 * The tunnel port's own "already in use". Not `portInUseMessage`: that one
 * tells the operator to move `PADDOCK_PORT`, which is the DASHBOARD's port and
 * not the one that failed here. A message naming the wrong variable sends them
 * to change a setting that was never the problem.
 *
 * Pure, like the builders in `startup-errors.ts`, and for the same reason: the
 * wording is the part worth asserting, and asserting it must not need a bound
 * port.
 */
export function gatedPortInUseMessage(port: number, hostname = "127.0.0.1"): string {
  return [
    `paddock: the tunnel's port ${port} is already in use`,
    `  something is already listening on ${hostname}:${port}`,
    "  paddock tunnel needs a SECOND loopback port, besides the dashboard's own.",
    `  stop whatever holds it, or move it: PADDOCK_TUNNEL_PORT=${port + 1} paddock tunnel`,
  ].join("\n");
}

/**
 * Own the child, draw the block, and shut both down together.
 *
 * Returns the process exit code: 0 for a shutdown the operator asked for
 * (`--for` elapsing) that actually completed, non-zero for a `cloudflared`
 * failure OR for a teardown that could not kill the child — see `teardown`, and
 * `index.ts`'s signal handler for the same rule on the `Ctrl-C` path. A child
 * that dies on its own is never left as a dashboard serving a URL that no longer
 * resolves. A `Ctrl-C` shutdown does not come back through this promise at all:
 * the signal handler in `index.ts` awaits the teardown registered below and
 * then exits the process, so this promise is simply abandoned.
 */
export async function runTunnel(deps: TunnelDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const start = deps.startTunnel ?? realStartTunnel;

  /**
   * RETURNED, never thrown. An escaping throw here killed the process from
   * inside a top-level `await` in index.ts, which skipped BOTH `removeState`
   * calls — so a `paddock.state.json` describing a process that no longer
   * exists survived, and the next `paddock status` reported a running paddock.
   * A refusal is an exit code, and the caller's ordinary exit path clears the
   * state file on the way out.
   *
   * EADDRINUSE only, exactly as index.ts does for the dashboard's own port.
   * Everything else rethrows with its stack intact: a catch that reported every
   * failure as a port conflict would be worse than the trace it replaced.
   */
  let gated: { port: number; stop(): void };
  try {
    gated = serveGated(deps);
  } catch (err) {
    if (errorCode(err) !== "EADDRINUSE") throw err;
    console.error(gatedPortInUseMessage(deps.port));
    return 1;
  }

  let tunnel: Tunnel | null = null;
  /**
   * The child, from the moment it is spawned — which is EARLIER than `tunnel`,
   * by however long cloudflared takes to publish a URL (seconds, sometimes
   * tens of them). Without this the teardown had nothing to kill during that
   * window and a `SIGTERM` there orphaned the child; `startTunnel`'s `onSpawn`
   * exists for exactly this.
   */
  let child: Child | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;

  /**
   * Stopping the child MUST NOT be able to abort the rest of the teardown.
   *
   * Bun terminates the process on an unhandled rejection, so a `stop()` that
   * rejects — `kill()` against a child something else already reaped, say —
   * would kill paddock partway through shutting down: the gated listener left
   * bound, the state file left behind, and, if the kill only partly landed, a
   * PUBLIC URL still live with no paddock behind it. That is the same failure
   * this whole shutdown path exists to prevent, arriving by another route.
   *
   * So it is reported — loudly, with the command to check by hand, because
   * this project never swallows an error — and then stepped past. Reported AND
   * remembered: `childKillFailed` is what stops the exit status from calling
   * this a success. See `teardown`.
   */
  let childKillFailed = false;
  const stopChild = async (kill: () => Promise<void>): Promise<void> => {
    try {
      await kill();
    } catch (e) {
      childKillFailed = true;
      console.error(
        `paddock: could not stop cloudflared (${String(e)}) — the tunnel may still be up. ` +
          "Check by hand: pgrep -af 'cloudflared tunnel'",
      );
    }
  };

  /**
   * Shut everything this run owns down, and report whether it WORKED.
   *
   * `true` means the child is gone (or there never was one). `false` means
   * `kill()` was refused and a `cloudflared` may still be holding a public URL
   * with no paddock behind it — the single failure this whole feature exists to
   * prevent. That outcome must NOT reach a caller as a success: an exit code is
   * read by wrapper scripts, by systemd, and by `&&` in a shell, and telling
   * any of them "clean shutdown" while a public URL is still live is exactly
   * the error this project's no-swallowing rule forbids.
   *
   * It is still only REPORTED, never thrown, and the rest of the teardown still
   * runs: the listener closes and the state file is cleared either way. Report
   * and continue, then exit non-zero.
   */
  const teardown = async (): Promise<boolean> => {
    // An already-torn-down run answers with the outcome it had, not with a
    // fresh `true` — a Ctrl-C arriving after a failed `--for` teardown must
    // not launder that failure into a clean exit.
    if (stopping) return !childKillFailed;
    stopping = true;
    if (timer !== null) clearInterval(timer);
    // THREE startup states, and the child must die in the two where one
    // exists. `tunnel` is set only once cloudflared has published a URL;
    // `child` is set from the moment it was spawned; both are null before
    // that. The same kill sequence runs either way — `Tunnel.stop()` IS
    // `terminate(child)` — so the only difference is which handle is to hand.
    // Bound to locals: the arrow closures below would otherwise widen these
    // back to `| null` (TypeScript cannot know when a callback runs).
    const up = tunnel;
    const spawned = child;
    if (up !== null) await stopChild(() => up.stop());
    else if (spawned !== null) {
      console.info("paddock: closing cloudflared before it published a URL");
      await stopChild(() => terminate(spawned));
    } else {
      // Nothing was ever spawned: `startTunnel` had not been reached, or its
      // own failure path already killed what it spawned.
      console.info("paddock: no tunnel was running");
    }
    gated.stop();
    deps.setPublicUrl?.(null);
    // Only claimed when there was something to close. "tunnel closed" after
    // "no tunnel was running" is a log that contradicts itself two lines apart.
    if (up !== null || spawned !== null) console.info("\npaddock: tunnel closed");
    return !childKillFailed;
  };

  /**
   * ONE SIGNAL HANDLER PER PROCESS. Do not add `process.on("SIGINT", …)` here.
   *
   * `index.ts` already registers SIGINT/SIGTERM handlers that clear the state
   * file and then call `process.exit(0)`. A second pair here would fire
   * alongside them, and Node/Bun runs handlers concurrently rather than in
   * sequence — index.ts's `process.exit(0)` would very likely land before
   * `tunnel.stop()` had finished awaiting the child's death. The result is a
   * cloudflared ORPHANED by the paddock that spawned it: a public URL, still
   * resolving, with nothing on the other end of it that anyone is watching.
   * It is the worst failure this feature has, and it is invisible from the
   * terminal that just returned to a prompt.
   *
   * The teardown is therefore handed OUT, and index.ts's existing handler
   * awaits it before removing the state file and exiting. If a future edit
   * needs shutdown work here, add it to `teardown` — never a new handler.
   */
  deps.registerShutdown?.(teardown);

  try {
    tunnel = await start({
      port: gated.port,
      bin: deps.bin,
      // The child, the instant it exists. `registerShutdown` above has already
      // handed the teardown out, so from here on a signal has something to
      // kill even though this await may not return for another thirty seconds.
      onSpawn: (c) => { child = c; },
    });
  } catch (e) {
    // `startTunnel` kills whatever it spawned on every path that rejects, so
    // there is no child left to reap here — only the listener to close.
    stopping = true; // and nothing for a later teardown to repeat
    gated.stop();
    deps.setPublicUrl?.(null);
    // Loud and specific: this is the one failure the operator cannot diagnose
    // from a dashboard, because there is no dashboard to look at.
    console.error(`paddock: could not publish a tunnel — ${(e as Error).message}`);
    return 1;
  }
  const live = tunnel;

  deps.setPublicUrl?.(live.url);
  const startedAt = now();
  const deadline = deps.deadlineMs != null ? startedAt + deps.deadlineMs : null;
  const tty = deps.isTty ?? Boolean(process.stdout.isTTY);
  const colour = useColour(deps.env ?? process.env, tty);

  let lastCode: string | null = null;
  let lastPaired: number | null = null;

  const block = () =>
    render(
      {
        url: live.url,
        code: deps.pairing.current().code,
        codeExpiresAt: deps.pairing.current().expiresAt,
        paired: deps.pairing.pairedCount,
        startedAt,
        deadline,
        now: now(),
      },
      colour,
    );

  const draw = () => {
    if (tty) {
      // Home, then clear to end of screen: a redraw, not a scroll.
      process.stdout.write(`\x1b[H\x1b[J${block()}\n`);
      return;
    }
    // Not a tty: print only when something an operator cares about CHANGED.
    // Cursor moves in a log file are their own small disaster, and a
    // per-second countdown in one is noise that hides the events.
    //
    // `lastCode`/`lastPaired` start as null rather than as the current values
    // so that the FIRST draw always prints. Seeded with the current values, a
    // detached or piped run would never print the URL or the code at all —
    // the two things the operator opened the log to find.
    const code = deps.pairing.current().code;
    const paired = deps.pairing.pairedCount;
    if (code !== lastCode || paired !== lastPaired) {
      lastCode = code;
      lastPaired = paired;
      console.info(block());
    }
  };

  draw();
  timer = setInterval(draw, 1000);

  const deadlineHit =
    deadline === null
      ? new Promise<"deadline">(() => {})
      : new Promise<"deadline">((r) => {
          setTimeout(() => r("deadline"), deadline - startedAt).unref?.();
        });

  const outcome = await Promise.race([
    live.exited.then((c) => ({ kind: "child" as const, code: c })),
    deadlineHit.then(() => ({ kind: "deadline" as const, code: 0 })),
  ]);

  if (outcome.kind === "child") {
    console.error(`paddock: cloudflared exited ${outcome.code} — the URL is gone`);
    // The result is not consulted here only because every exit from this branch
    // is already non-zero: a tunnel that vanished is a failure, and a kill that
    // then failed cannot make it more so.
    await teardown();
    // A child that exits 0 unasked is still a tunnel that vanished.
    return outcome.code === 0 ? 1 : outcome.code;
  }
  console.info(`paddock: --for ${human(deps.deadlineMs ?? 0)} elapsed`);
  // The ONE path where the operator asked for this shutdown — so it is also the
  // one path where a failed kill is the difference between exit 0 and exit 1.
  return (await teardown()) ? 0 : 1;
}
