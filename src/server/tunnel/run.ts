import type { AgentStore } from "@server/state/store";
import type { Hub } from "@server/ws/hub";
import { hubWebSocket, tryUpgradeWs, type WsData } from "@server/ws/serve";
import {
  startTunnel as realStartTunnel,
  terminate,
  type Child,
  type Tunnel,
} from "@server/tunnel/cloudflared";
import { decide, gateResponse, setCookie } from "@server/tunnel/gate";
import {
  bridgeWebSocket, closeUp, forwardUp, proxyHttp,
  type ProxySocket, type Upstream,
} from "@server/tunnel/proxy";
import { pairOutcome } from "@server/tunnel/pairing";
import { errorCode } from "@server/startup-errors";
import type { Pairing } from "@server/tunnel/pairing";
import { qrMatrix } from "@server/qr";
import { render, useColour } from "@server/tunnel/display";
import { duration, warn } from "@server/term";

/**
 * How many cloudflared lines are kept while the display owns the screen.
 *
 * Enough to carry a failure's context — cloudflared reports a refused
 * connection or a rejected tunnel over several lines — and small enough that a
 * long-running tunnel's buffer is not a leak. The tail is what matters: the
 * lines just before it broke are the ones that say why.
 */
const CLOUDFLARED_TAIL = 50;

export interface TunnelDeps {
  /**
   * What the gated listener serves.
   *
   * Absent under `upstream`, where there is no local app to serve — the
   * publishing tunnel forwards to a paddock in another process instead.
   */
  app?: { fetch(req: Request): Response | Promise<Response> };
  hub?: Hub;
  hostId?: string;
  store?: AgentStore;
  /**
   * Serve a paddock ALREADY RUNNING here rather than this process's own.
   *
   * `paddock tunnel` is a whole second paddock: it opens its own herdr stream
   * and builds its own notifier, which is why running one beside an existing
   * instance would notify twice for every agent. Attaching exists so a paddock
   * that is already serving can be published without being stopped, and it
   * works by having NO store, hub, notifier or herdr connection of its own —
   * only the gate, and a proxy to the process that has them.
   */
  upstream?: Upstream;
  pairing: Pairing;
  /** 0 lets the OS pick, which is what the tests use. */
  port: number;
  bin?: string;
  deadlineMs?: number | null;
  startTunnel?: typeof realStartTunnel;
  setPublicUrl?: (url: string | null) => void;
  /**
   * The origins a `/ws` upgrade on THIS listener may claim, for the same-origin
   * gate in `ws/serve.ts`. A thunk because a tunnel run learns its own hostname
   * partway through starting up.
   *
   * Optional, defaulting to none: empty is `origin.ts`'s documented "no public
   * hostname is known" case, under which the origin/Host comparison still
   * applies. A test that omits it is therefore testing the same rule an
   * operator without a saved `publicUrl` runs under, not a relaxed one.
   */
  publicHosts?: () => readonly string[];
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
   * Terminal dimensions, injected for the same reason `isTty` is: a test that
   * read `process.stdout.columns` would pass or fail depending on the window
   * the suite happened to run in.
   */
  columns?: number;
  rows?: number;
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
  const up = deps.upstream;
  const server = up === undefined
    ? Bun.serve<WsData>({
      port: deps.port,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const d = decide(req, (t) => deps.pairing.has(t));
        if (d.kind !== "pass") return gateResponse(d, req);

        // Past the gate, this listener serves EXACTLY what the plain one serves,
        // from one definition — see `ws/serve.ts`. `null` means the request is
        // not the socket route and belongs to the app.
        const ws = tryUpgradeWs(req, srv, deps.publicHosts?.() ?? []);
        if (ws !== null) return ws;
        return deps.app!.fetch(req);
      },
      websocket: hubWebSocket({ hub: deps.hub!, hostId: deps.hostId!, store: deps.store! }),
    })
    /*
     * ATTACHED. The gate is identical — `decide`/`gateResponse` above and here
     * are the same two calls, so a refusal cannot differ between the two modes.
     * What changes is only what a PASSING request reaches: another process
     * rather than an app this one built.
     *
     * `tryUpgradeWs` is deliberately not used here. It exists to hand a socket
     * to the local hub, and there is no local hub in this mode — the upgrade is
     * accepted and then bridged upstream instead.
     */
    : Bun.serve<{ proxy: ProxySocket }>({
      port: deps.port,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const d = decide(req, (t) => deps.pairing.has(t));
        if (d.kind !== "pass") return gateResponse(d, req);

        // `/pair` is THIS listener's own, never proxied. The gate belongs to
        // this process — the upstream has no pairing at all and would
        // answer 404, which is what shipped for a few minutes and made the
        // code on the terminal unusable. `pairOutcome` is shared with the app's
        // route so the two cannot answer a code differently.
        const path = new URL(req.url).pathname;
        if (path === "/pair" && req.method === "POST") {
          return (async () => {
            let body: unknown;
            try { body = await req.json(); } catch { body = null; }
            const out = pairOutcome((body as { code?: unknown } | null)?.code, deps.pairing);
            return new Response(JSON.stringify(out.body), {
              status: out.status,
              headers: {
                "content-type": "application/json",
                ...(out.token === undefined ? {} : { "set-cookie": setCookie(out.token) }),
              },
            });
          })();
        }

        if (path === "/ws") {
          const ok = srv.upgrade(req, { data: { proxy: { up: null, pending: [] } } });
          // Bun returns false when the request was not a valid upgrade. Said,
          // not swallowed: a silent 200 here looks to the browser like a
          // socket that opened and then never spoke.
          return ok ? undefined : new Response("upgrade failed", { status: 400 });
        }
        return proxyHttp(req, up);
      },
      websocket: {
        open: (ws) => bridgeWebSocket(ws, up),
        message: (ws, msg) => forwardUp(ws.data.proxy, msg as string | Uint8Array),
        close: (ws) => closeUp(ws.data.proxy),
      },
    }) as unknown as ReturnType<typeof Bun.serve<WsData>>;
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
    "  `paddock tunnel` needs a SECOND loopback port, besides the dashboard's own.",
    `  stop whatever holds it, or move it: PADDOCK_TUNNEL_PORT=${port + 1} paddock tunnel`,
  ].join("\n");
}

/** 29 modules + a 4-module quiet zone on each side. */
const QR_COLS = 37;

/**
 * The row thresholds, EXPORTED so `tunnel-display.test.ts` can tie them to
 * what `render` actually emits rather than to arithmetic done once in a
 * comment.
 *
 * `draw` writes `${block()}\n`, so a block of N lines occupies N + 1 terminal
 * rows. That trailing row is not bookkeeping: without it the block scrolls, and
 * a scrolled block makes the once-a-second `\x1b[H\x1b[J` repaint tear.
 *
 * Measured, not derived. The trimmed block is 26 lines with a `--for` deadline
 * (status, URL, blank, 19 QR, blank, code, paired, closes) and the full block
 * is 33. An earlier count put the trimmed threshold at 26 by folding the
 * trailing row into the block's own line count — which admitted the QR onto a
 * terminal exactly one row too short to hold it.
 */
export const QR_ROWS_THRESHOLD = 27;
export const FULL_ROWS_THRESHOLD = 34;

/**
 * Whether to draw a QR at all.
 *
 * `colour` already carries "is a tty" and "NO_COLOR is unset" — see
 * `useColour` — and both are suppression reasons here for the same underlying
 * one: the QR's polarity is forced with escapes, so without escapes it would
 * render inverted against a dark terminal, and an inverted QR is worse than no
 * QR. A QR in a piped log is noise besides.
 *
 * Suppression lives HERE and not in `render`'s colour flag, because
 * `tunnel-display.test.ts` requires that flag to change escapes and nothing
 * else. Presence is `DisplayState.qr`; polarity is `colour`.
 */
export function wantsQr(o: { colour: boolean; columns: number; rows: number }): boolean {
  return o.colour && o.columns >= QR_COLS && o.rows >= QR_ROWS_THRESHOLD;
}

/**
 * Whether the terminal is too short for the QR AND the prose.
 *
 * Takes `qr`, because the prose is dropped to make ROOM for a QR — so with no
 * QR there is nothing to make room for. Dropping it anyway is pure loss: a
 * default 80x24 gets no QR, and it would have silently lost the on-screen
 * warning that the pairing code is the only thing between a public URL and
 * keystroke access to every agent. That warning is printed every second on
 * purpose. Without this guard the third regime in the design —
 * "no QR; the block exactly as it is today" — quietly became a trimmed block.
 *
 * `render` still treats `qr` and `compact` as independent inputs and handles
 * all four combinations; it is only the DECISION here that couples them.
 */
export function wantsCompact(o: { qr: boolean; rows: number }): boolean {
  return o.qr && o.rows < FULL_ROWS_THRESHOLD;
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
   * cloudflared's own output, and why it stops reaching the screen.
   *
   * `startTunnel` logs every line it reads for the life of the child, and the
   * display redraws with `\x1b[H\x1b[J` once a second. Both write to stdout, so
   * a cloudflared line appeared wherever the cursor happened to be and was
   * erased by the next repaint: a flash, then nothing. Measured with the line
   * that matters most — `Initiating graceful shutdown due to signal interrupt`
   * — which flashed and vanished under a block still reading `tunnel up`.
   *
   * Not silenced. This project does not swallow errors, and cloudflared's
   * stderr is the ONLY place a tunnel failure explains itself. So the lines are
   * kept and printed on every path that fails, where `paddock: cloudflared
   * exited N — the URL is gone` used to be the whole explanation.
   *
   * Only while the display owns the screen, and only on a tty. A piped or
   * detached run has no repaint to collide with and a log file wants every
   * line, so there it stays pass-through.
   */
  const recent: string[] = [];
  let displayOwnsScreen = false;
  const onLog = (line: string) => {
    if (!displayOwnsScreen) {
      // Before the URL exists there is no display yet, and a thirty-second wait
      // in silence is exactly when the operator needs to see progress.
      console.info(`[cloudflared] ${line}`);
      return;
    }
    recent.push(line);
    if (recent.length > CLOUDFLARED_TAIL) recent.shift();
  };

  /**
   * Hand back what cloudflared said, on the paths where it is the answer.
   *
   * Drains the buffer, so two failures in one run cannot print the same lines
   * twice and imply twice as much evidence as there is.
   */
  const dumpCloudflared = () => {
    if (recent.length === 0) return;
    warn(`paddock: the last ${recent.length} line(s) from cloudflared:`);
    for (const line of recent) warn(`  [cloudflared] ${line}`);
    recent.length = 0;
  };

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
      dumpCloudflared();
      warn(
        `paddock: could not stop cloudflared (${String(e)}) — the tunnel may still be up. ` +
          "Check by hand: `pgrep -af 'cloudflared tunnel'`",
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
    // The last frame drawn says `tunnel up`. Leaving it there while the child is
    // being killed makes the screen assert the one thing that has just stopped
    // being true — and `^C` reaches cloudflared straight from the tty, so its
    // own `graceful shutdown` line has usually already been written and erased
    // by a repaint. Clear the block; what follows is the closing report.
    if (displayOwnsScreen) {
      process.stdout.write("\x1b[H\x1b[J");
      displayOwnsScreen = false;
    }
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
      // Routed rather than defaulted: the default prints straight to stdout for
      // the life of the child, which is the collision described above.
      onLog,
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
  const columns = deps.columns ?? process.stdout.columns ?? 0;
  const rows = deps.rows ?? process.stdout.rows ?? 0;
  const qrOn = wantsQr({ colour, columns, rows });
  const compact = wantsCompact({ qr: qrOn, rows });

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
        // Recomputed per draw so the QR follows the code when it rotates —
        // `qrMatrix` memoises on the payload, so this is one encode per
        // rotation rather than one per second.
        qr: qrOn ? qrMatrix(`${live.url}/#${deps.pairing.current().code}`) : null,
        compact,
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
  // From here the screen is a repainted block, not a log. Only on a tty: a
  // piped run keeps every cloudflared line, because nothing overwrites them
  // there and the log is the only record that will exist.
  displayOwnsScreen = tty;
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
    /**
     * A death this run ASKED for is not a failure, and must not be reported as
     * one.
     *
     * `^C` reaches cloudflared straight from the tty — same foreground process
     * group — so the child dies at the same moment index.ts's handler calls
     * `teardown`. Both land: the teardown prints its closing report, and this
     * branch used to print `cloudflared exited 143 — the URL is gone` beside
     * it, followed by the tail as its diagnosis. On a tunnel that had been up
     * for half an hour that tail is whatever cloudflared last happened to say
     * — its SUCCESSFUL startup prechecks — presented as the explanation of a
     * crash. 143 is the signal the operator sent, and the URL going away is
     * what they asked for.
     *
     * Nothing is swallowed. cloudflared's shutdown lines still print live
     * (`teardown` drops the display first, so `onLog` is pass-through again),
     * `teardown` still says `tunnel closed`, and a kill that FAILED still
     * warns and still ends the run non-zero — the exit status comes from
     * `teardown`, which answers with the outcome it already had.
     */
    if (stopping) return (await teardown()) ? 0 : 1;
    warn(`paddock: cloudflared exited ${outcome.code} — the URL is gone`);
    // The lines above are the diagnosis. Without them this message names the
    // exit code and nothing that would explain it.
    dumpCloudflared();
    // The result is not consulted here only because every exit from this branch
    // is already non-zero: a tunnel that vanished is a failure, and a kill that
    // then failed cannot make it more so.
    await teardown();
    // A child that exits 0 unasked is still a tunnel that vanished.
    return outcome.code === 0 ? 1 : outcome.code;
  }
  console.info(`paddock: --for ${duration(deps.deadlineMs ?? 0)} elapsed`);
  // The ONE path where the operator asked for this shutdown — so it is also the
  // one path where a failed kill is the difference between exit 0 and exit 1.
  return (await teardown()) ? 0 : 1;
}
