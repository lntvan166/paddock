import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/routes";
import { createDemoSource, DemoSource, DEMO_HOST_ID } from "@server/demo";
import {
  HerdrStream,
  ProtocolMismatchError,
  checkProtocol,
  request,
  type Subscription,
} from "@server/herdr/socket";
import { createActions, type HerdrActions } from "@server/herdr/actions";
import { StreamKeeper } from "@server/herdr/keeper";
import { AgentStore } from "@server/state/store";
import { Supervisor } from "@server/supervisor";
import { Hub } from "@server/ws/hub";
import { hubWebSocket, tryUpgradeWs, type WsData } from "@server/ws/serve";
import { buildIdFrom } from "@server/build-id";
import { SettingsStore, defaultConfigDir, isConfigured } from "@server/settings/store";
import { recordState, removeState } from "@server/lifecycle/state";
import { runStart, runStatus, runStop } from "@server/lifecycle/commands";
import { sendTelegram } from "@server/notify/telegram";
import { Notifier, fanOut } from "@server/notify/notifier";
import { parseArgs, parseDuration, USAGE } from "@server/cli";
import { Pairing } from "@server/tunnel/pairing";
import { preflight, tunnelHint } from "@server/tunnel/preflight";
import { runTunnel } from "@server/tunnel/run";
import { VERSION } from "@server/version";
import { runDoctor } from "@server/doctor";
import { runUpdate } from "@server/update";
import { noUpdateCheckRequested, startUpdateCheck } from "@server/update-check";
import {
  errorCode,
  herdrUnreachableMessage,
  inspectSocketPath,
  isDiagnosableHerdrFailure,
  portInUseMessage,
} from "@server/startup-errors";

const { command, flags, values, verb } = parseArgs(Bun.argv.slice(2));
const DEMO = flags.has("--demo");
const PORT = Number(process.env.PADDOCK_PORT ?? 8787);
const HOSTNAME = "127.0.0.1"; // loopback only; exposure is the tunnel's job

// Reserved, and routed through the parser like every other verb. This used to
// scan raw `Bun.argv` instead — two argv mechanisms in one function, which is
// also how `paddock --demo agent` came out as `serve` from parseArgs and as
// `agent` from here. Exit code 2 and the roadmap pointer are unchanged.
if (command === "agent" || command === "hub") {
  console.error(`paddock ${command}: not implemented — see docs/roadmap.md`);
  process.exit(2);
}

// An unrecognised verb must NOT fall through to serve. `paddock updte` used to
// launch a dashboard, which on a branch whose whole purpose is introducing
// verbs is the "never swallow errors" shape — the operator asked for something
// that does not exist and got a working-looking server instead of being told.
if (command === "unknown") {
  console.error(`paddock: unknown command '${verb}'`);
  console.error(USAGE);
  process.exit(2);
}

// Before anything opens a socket or binds a port — asking what the tool does
// must never start it. See parseArgs for what `--help` used to do here.
if (command === "help") {
  console.log(USAGE);
  process.exit(0);
}

if (flags.has("--version") || flags.has("-V")) {
  console.log(VERSION);
  process.exit(0);
}

// Must run before any server setup below: `paddock update` should not open a
// herdr socket or bind a port.
if (command === "update") {
  process.exit(await runUpdate({
    // MUST be process.execPath, not Bun.argv[0]. In a COMPILED binary
    // (`bun build --compile`, which is what this ships as), Bun.argv[0] is
    // the literal string "bun" — not a path at all — when the binary is
    // invoked as a bare name off PATH (measured by compiling a probe and
    // running it as a bare name: argv0 was "bun", execPath was the probe's
    // real absolute path). dirname("bun") is ".", so using Bun.argv[0] here
    // would write .paddock.new into the operator's CURRENT WORKING
    // DIRECTORY and rename over ./paddock — a stray file wherever they
    // happened to be standing, and the real install never touched.
    // process.execPath is the compiled binary's actual absolute path in
    // both the compiled and interpreted (`bun src/server/index.ts`) cases.
    // In a source checkout it resolves to the operator's own bun
    // installation — Ruling P1 (the 0.0.0-dev refusal above) is what makes
    // that case safe, not this path choice.
    selfPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    current: VERSION,
    checkOnly: flags.has("--check"),
  }));
}

// Must run before any server setup below, same reasoning as `update` above:
// `status` should not open a herdr socket or bind a port just to answer a
// question that only needs the state file and a signal-0 probe.
if (command === "status") {
  process.exit(await runStatus({ dir: defaultConfigDir() }));
}

// Must run before any server setup below, same reasoning as `update` and
// `status` above: `stop` should not open a herdr socket or bind a port just
// to signal a pid it reads from the state file.
if (command === "stop") {
  process.exit(await runStop({ dir: defaultConfigDir(), force: flags.has("--force") }));
}

// Must run before any server setup below, same reasoning as the three verbs
// above: `start` itself never binds a port or opens a herdr socket — it only
// spawns a detached child (which is this same binary, re-invoked with no
// verb, and IS the thing that binds a port) and waits for that child's own
// state file and health endpoint to confirm it is actually serving.
if (command === "start") {
  process.exit(await runStart({ dir: defaultConfigDir(), demo: DEMO }));
}

/**
 * `paddock tunnel` is dispatched in TWO halves, and this is the first of them.
 *
 * The refusals belong up here with the other early verbs for the reason
 * preflight.ts states: a command that is going to fail must not bind a port or
 * open a herdr socket on its way to failing. But there is a sharper reason it
 * cannot go down beside `runTunnel` at the bottom of this file. By that point
 * `recordState` has written THIS process's pid and command line into
 * paddock.state.json, and `preflight` asks `checkState` whether a paddock is
 * already running — which probes that pid with signal 0, finds itself alive,
 * matches its own args, and answers "running". Every `paddock tunnel` would
 * refuse to start, quoting its own pid back at the operator.
 *
 * The second half — the pairing gate, the second listener and the child — is
 * at the very bottom, after the signal handlers, because it must not run
 * before there is a handler able to tear it down. See the comment there.
 */
let tunnelBin: string | undefined;
let tunnelDeadlineMs: number | null = null;
if (command === "tunnel") {
  const raw = values.get("--for");
  // `--for` with nothing after it. The parser leaves a trailing value flag
  // unconsumed, so `values` has no entry and `raw` is indistinguishable from
  // "the flag was never given" — which would make the typo mean NO DEADLINE,
  // silently, on the one flag whose entire job is bounding how long a public
  // URL lives. `flags` is what tells the two apart.
  if (flags.has("--for") && raw === undefined) {
    console.error("paddock: --for needs a duration (try 45s, 90m, 2h)");
    process.exit(1);
  }
  const parsed = raw === undefined ? null : parseDuration(raw);
  if (raw !== undefined && parsed === null) {
    console.error(`paddock: --for ${raw} is not a duration (try 45s, 90m, 2h)`);
    process.exit(1);
  }
  tunnelDeadlineMs = parsed;

  const pre = await preflight({ dir: defaultConfigDir() });
  if (!pre.ok) {
    console.error(pre.message);
    process.exit(1);
  }
  tunnelBin = pre.bin;
}

const socketPath =
  process.env.PADDOCK_HERDR_SOCKET ?? join(homedir(), ".config", "herdr", "herdr.sock");

// Must run before any server setup below, same reasoning as the four verbs
// above: asking whether paddock can talk to herdr must not bind a port or open
// the event stream. It sits here rather than beside them only because it needs
// socketPath — everything between that and here builds plain objects.
if (command === "doctor") {
  process.exit(await runDoctor({ socketPath }));
}

const hostId = DEMO ? DEMO_HOST_ID : (process.env.PADDOCK_HOST_ID ?? "local");
const store = new AgentStore(hostId);
/**
 * The build currently on disk, re-read rather than captured at startup.
 *
 * `make dev` rebuilds the UI without restarting this process, so a value read
 * once would go stale in exactly the workflow that most needs it. Cached
 * against the file's mtime, so the common case is a stat rather than a read,
 * and a rebuild is picked up on the next heartbeat.
 */
const STATIC_DIR = process.env.PADDOCK_STATIC_DIR ?? "dist";

let buildCache: { mtimeMs: number; id: string | null } | null = null;

function currentBuildId(): string | null {
  try {
    const file = `${STATIC_DIR}/index.html`;
    const { mtimeMs } = statSync(file);
    if (buildCache?.mtimeMs !== mtimeMs) {
      buildCache = { mtimeMs, id: buildIdFrom(readFileSync(file, "utf8")) };
    }
    return buildCache.id;
  } catch {
    // No built UI (dev through Vite, or a fresh checkout). Null means "cannot
    // tell", and the client treats that as "no update to announce" rather
    // than announcing one on every heartbeat forever.
    return null;
  }
}

/**
 * Filled in asynchronously, below, and read on every heartbeat/snapshot (via
 * the Hub, so an already-open tab learns of it too — see shared/types.ts's
 * comment on ServerMessage) and by `health()` on every request.
 *
 * Fired WITHOUT awaiting — a version check must never delay the server
 * binding its port, and this variable simply stays `null` (its honest "don't
 * know yet" value) until the one background check resolves.
 *
 * `startUpdateCheck` rather than a bare `void checkForUpdate(...).then(...)`:
 * that form had no `.catch`, and Bun terminates the process on an unhandled
 * rejection — so a check that threw killed a server that had already bound
 * its port and was serving. The rejection handler lives with the check
 * itself now, where it cannot be dropped by an edit to this file.
 */
let latestKnown: string | null = null;
startUpdateCheck(
  {
    dir: defaultConfigDir(),
    current: VERSION,
    now: Date.now(),
    disabled: noUpdateCheckRequested(),
  },
  (v) => { latestKnown = v; },
);

const hub = new Hub({ build: currentBuildId, latestKnown: () => latestKnown });

const settings = new SettingsStore(defaultConfigDir());
await settings.load();
// Never log settings.error's cause verbatim if that ever changes to include
// file contents — today it is only "unreadable" / "not valid JSON" messages,
// never the token, but the rule is never swallow errors either way.
if (settings.error) console.error(`[settings] ${settings.error}`);

/**
 * The live quick-tunnel URL, or null. IN MEMORY ONLY, deliberately: it must
 * reach the notifier so a Telegram deeplink points somewhere the phone can
 * open, and it must NEVER be written to settings.json, where `publicUrl` may
 * already hold the real hostname of a named-tunnel deployment.
 */
let tunnelUrl: string | null = null;

const notifier = new Notifier({
  settings,
  // A getter, so the notifier reads whatever is live at send time rather than
  // capturing a URL that did not exist yet when it was constructed.
  publicUrlOverride: () => tunnelUrl,
  send: async (text, replyMarkup) => {
    const s = settings.current();
    // The same `isConfigured` the store's view() and the routes use — one
    // definition, four call sites. Falsiness here and `!== null` in the
    // notifier used to disagree over an empty-string token.
    if (!isConfigured(s.telegram.token) || !isConfigured(s.telegram.chatId)) {
      return { ok: false, detail: "not configured" };
    }
    return sendTelegram({ token: s.telegram.token, chatId: s.telegram.chatId, text, replyMarkup });
  },
});

let supervisor: Supervisor | null = null;
let demo: DemoSource | null = null;
// Demo has no herdr to act on, so the herdr-backed action routes stay unset
// and 404 honestly rather than pretending to answer a synthetic agent. `/ack`
// is unaffected: it is registered unconditionally in routes.ts because it
// touches only paddock's own store, so dismissing a finished agent works in
// `--demo` too — which is the mode README screenshots come from.
let actions: HerdrActions | undefined;
// Health reads the stream itself rather than a cached boolean: a flag can go
// stale (and did — a failed reopen left it saying `true` with no stream at
// all), whereas `stream.connected` cannot disagree with reality.
let stream: HerdrStream | null = null;

if (DEMO) {
  // Every tick goes through the store, so `/api/agents` and a browser that
  // loads the page an hour in both see current state — not startup state.
  //
  // DELIBERATELY `hub.queue` alone, NOT `fanOut(hub, notifier)`. The demo
  // agents are synthetic and cycle through `blocked` and `done` on a timer;
  // wiring the notifier here would fire real Telegram messages, at a
  // synthetic agent's tempo, to whatever chat the operator has configured —
  // and `--demo` is the mode README screenshots are taken in. This is the one
  // legitimate instance of the bypass `docs/roadmap.md` warns about under
  // "Nothing guards index.ts's call site for the delta fan-out": a future
  // guard against that bypass must exempt this line rather than "fix" it.
  demo = createDemoSource({ store, onDelta: (d) => hub.queue(d) });
  store.replaceAll(demo.snapshot(), Date.now());
  demo.start();
  console.info("paddock: demo mode — synthetic agents, no herdr connection");
} else {
  // The stream is the only long-lived connection. Requests each open their own.
  let keeper: StreamKeeper | null = null;

  const herdrStream = new HerdrStream({
    path: socketPath,
    onEvent: (e) => supervisor?.handleEvent(e),
    onStateChange: (up) => {
      console.info(`herdr event stream ${up ? "connected" : "disconnected"}`);
      // A drop we did not ask for: start recovering. HerdrStream calls this
      // with `false` only when there is genuinely no stream left and nobody
      // asked for that — a real drop, or a reopen that tore down a live
      // socket and then failed to replace it. A routine resubscribe that
      // SUCCEEDS reports nothing but the final `true`, so this does not fire
      // on every ordinary agent start/exit.
      if (!up) keeper?.notifyClosed();
    },
  });
  stream = herdrStream;
  actions = createActions(socketPath);
  const client = {
    request: <T,>(method: string, params?: object) => request<T>(socketPath, method, params),
    openStream: (subs: Subscription[]) => herdrStream.open(subs),
  };
  supervisor = new Supervisor({
    client,
    store,
    // Fan out, do not replace: the hub keeps every browser current, and the
    // notifier is a leaf hanging off the composition root so that neither
    // store.ts nor hub.ts has to learn that Telegram exists.
    onDelta: fanOut(hub, notifier),
    // The event-driven refreshes and the 30s healing reconcile are awaited by
    // nobody, so a rejection there used to be a log line and nothing more.
    // Arming the keeper makes a background failure self-heal instead.
    onBackgroundFailure: () => keeper?.notifyClosed(),
  });

  // The pane set after a herdr restart is usually IDENTICAL to what it was
  // before — same agents, dead socket. Supervisor.resubscribe() skips
  // re-opening the stream when the computed pane set matches what it already
  // believes is live, so invalidateSubscription() must run first to clear
  // that belief; otherwise refresh() would reconcile, compute the same key,
  // take the early return, and never re-open the stream at all.
  //
  // invalidateSubscription() is a plain synchronous setter with no mutex and
  // is called immediately here, not queued behind Supervisor's own
  // refreshLoop/refreshQueued coalescing. It no longer needs to be: the
  // invalidation now also bumps a generation counter that resubscribe()
  // captures before awaiting openStream(), so an invalidation landing while
  // an UNRELATED refresh() is mid-open can no longer be overwritten by that
  // refresh's post-await `openPaneKey` write. The losing side is the stale
  // claim, not the invalidation — worst case one extra reopen.
  keeper = new StreamKeeper({
    refresh: () => {
      supervisor!.invalidateSubscription();
      return supervisor!.refresh();
    },
    onFatal: () => process.exit(1),
  });

  try {
    await checkProtocol(socketPath);
    await supervisor.start();
  } catch (err) {
    if (err instanceof ProtocolMismatchError) console.error(err.message);
    else {
      const kind = inspectSocketPath(socketPath);
      // Only what we can diagnose. A parse bug wearing a "cannot reach herdr"
      // message is harder to debug than the raw throw it replaced.
      if (isDiagnosableHerdrFailure(err, kind))
        console.error(herdrUnreachableMessage(socketPath, err, kind));
      else console.error(err);
    }
    process.exit(1);
  }
}

// Named rather than inline so `paddock tunnel` can build a SECOND app from the
// same dependencies plus the pairing gate — one description of the app, not two
// that could drift.
const appDeps = {
  store,
  hub,
  actions,
  settings,
  health: () => ({
    ok: true,
    hostId,
    agents: store.snapshot().length,
    clients: hub.clientCount,
    // Demo mode has no herdr; otherwise this is the stream's own answer.
    herdrConnected: DEMO ? true : (stream?.connected ?? false),
    lastEventAt: supervisor?.lastEventAt ?? (demo ? Date.now() : null),
    // A broken token fails every send silently otherwise; exposed here so it
    // is visible within seconds rather than never.
    lastNotifyError: notifier.lastError,
    version: VERSION,
    latestKnown,
  }),
  staticDir: process.env.PADDOCK_STATIC_DIR ?? "dist",
};

const app = createApp(appDeps);

try {
  Bun.serve<WsData>({
    port: PORT,
    hostname: HOSTNAME,
    fetch(req, server) {
      // The `/ws` interception, the `upgrade failed` 400 and the three hub
      // handlers below are shared with the tunnel's gated listener rather than
      // written out here — `ws/serve.ts` says why. `null` means this request
      // is not the socket route, so it belongs to the app.
      const ws = tryUpgradeWs(req, server);
      if (ws !== null) return ws;
      return app.fetch(req);
    },
    websocket: hubWebSocket({ hub, hostId, store }),
  });
} catch (err) {
  // EADDRINUSE only. Everything else rethrows with its stack intact — a
  // catch here that reported every failure as a port conflict would be worse
  // than the trace it replaced, and this project's rules forbid swallowing
  // errors, not formatting the one condition we recognise.
  if (errorCode(err) !== "EADDRINUSE") throw err;
  console.error(portInUseMessage(PORT, HOSTNAME));
  process.exit(1);
}

// A quiet system sends nothing at all, so without this the browser would
// declare a perfectly healthy link stale after 60s of idle agents.
hub.startHeartbeat();

console.info(`paddock listening on http://${HOSTNAME}:${PORT}`);

// Nothing to nudge an operator who is already running `paddock tunnel` toward.
if (command !== "tunnel") {
  const hint = tunnelHint(settings.current().publicUrl, false);
  if (hint !== null) console.info(hint);
}

// Written AFTER the bind, deliberately. A paddock that failed to take the port
// must not overwrite the state of the one already holding it.
//
// recordState never throws and reports its own failures: the dashboard is the
// product, and neither an unwritable config dir nor an unreadable command line
// may take down a paddock that has already bound its port. That is not
// hypothetical for the config dir — oven/bun:1-alpine's passwd has only uid
// 1000, and docker-compose.yml runs `user: "${UID}:${GID}"` from the host, so
// on any host whose UID isn't 1000 `homedir()` resolves to `/` and the write
// is EACCES — the exact shape that, unguarded, previously killed an
// already-bound server via startUpdateCheck (see update-check.ts).
const stateDir = defaultConfigDir();
await recordState(stateDir, {
  pid: process.pid,
  port: PORT,
  version: VERSION,
  startedAt: Date.now(),
});

/**
 * Extra teardown for whatever this run happens to own, or null.
 *
 * THE ONLY SIGNAL HANDLERS IN THIS PROCESS ARE THE PAIR BELOW. Anything that
 * needs to shut something down on Ctrl-C registers here instead of calling
 * `process.on("SIGINT", …)` itself — `paddock tunnel` does exactly that with
 * `registerShutdown`. Two handlers would run CONCURRENTLY, not in sequence,
 * and this one calls `process.exit(0)`: it would routinely win the race and
 * kill the process while the other was still awaiting a child's death, which
 * for the tunnel means an ORPHANED cloudflared — a public URL still resolving
 * with no paddock behind it, from a terminal that has already returned to a
 * prompt. See the matching comment in `tunnel/run.ts`.
 *
 * It resolves to whether the teardown actually worked, and `false` becomes a
 * non-zero exit status below.
 */
let onShutdown: (() => Promise<boolean>) | null = null;

// Foreground runs write it too, so `status` and `stop` do not depend on how
// paddock was started.
let clearing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (clearing) return;
    clearing = true;
    // Pending settle timers are unref'd, so they cannot hold the process
    // open — but a timer that fires against a torn-down store would report
    // about an agent nobody is watching any more.
    notifier.dispose();
    void (async () => {
      /**
       * 0 ONLY for a shutdown that actually finished.
       *
       * A `cloudflared` that could not be killed is a public URL still
       * resolving with nothing behind it — the one failure `paddock tunnel`
       * exists to prevent — and it is invisible from a terminal that has
       * returned to a prompt. Exiting 0 there would report that as success to
       * everything that reads an exit status: a wrapper script, a systemd
       * unit, `&&` in a shell. The teardown reports the failure on stderr and
       * keeps going, and the status is how the failure leaves this process.
       */
      let code = 0;
      try {
        // AWAITED, and before the exit below: the point of routing the
        // tunnel's teardown through here is that the child is dead before
        // this process is.
        const cleanly = await onShutdown?.();
        // `undefined` means no teardown was registered — a plain `paddock`,
        // with nothing that could have failed to stop.
        if (cleanly === false) code = 1;
      } catch (e) {
        // Reported, then stepped past. A teardown that failed must not stop
        // the state file from being cleared, or `status` reports a running
        // paddock for ever. Non-zero for the same reason as above: a teardown
        // that threw did not finish, and must not look like one that did.
        console.error(`paddock: shutdown step failed (${String(e)})`);
        code = 1;
      }
      await removeState(stateDir).catch((e) =>
        console.error(`paddock: could not clear state file (${String(e)})`),
      );
      process.exit(code);
    })();
  });
}

/**
 * The second half of `paddock tunnel` — see the first half near the top.
 *
 * LAST IN THE FILE, deliberately. `runTunnel` spawns cloudflared, and the
 * handler above is what kills it again; dispatching the tunnel any earlier
 * would open a window in which a `SIGTERM` reached a process with no handler
 * registered at all, which is the orphaned-child failure by yet another route.
 *
 * The plain listener above is already bound and behaves exactly as it does for
 * a bare `paddock`. Everything the tunnel adds is a SECOND listener.
 */
if (command === "tunnel") {
  const pairing = new Pairing();
  // Rebuilt WITH `pairing`, because the pairing routes must exist on the app
  // the gated listener serves — and must not exist on the plain one.
  const gatedApp = createApp({ ...appDeps, pairing, tunnelUrl: () => tunnelUrl });
  let code: number;
  try {
    code = await runTunnel({
      app: gatedApp,
      hub,
      hostId,
      store,
      pairing,
      port: Number(process.env.PADDOCK_TUNNEL_PORT ?? 8788),
      bin: tunnelBin,
      deadlineMs: tunnelDeadlineMs,
      setPublicUrl: (u) => { tunnelUrl = u; },
      registerShutdown: (fn) => { onShutdown = fn; },
    });
  } catch (err) {
    // `runTunnel` turns the failures it recognises into exit codes, so this is
    // the unrecognised remainder. The state file is cleared BEFORE the rethrow
    // regardless: a throw out of a top-level await ends the process without
    // running either `removeState` below, and the residue is a state file
    // describing a process that has gone — which `paddock status` then reports
    // as running. The error itself is rethrown untouched, stack and all.
    await removeState(stateDir).catch((e) =>
      console.error(`paddock: could not clear state file (${String(e)})`),
    );
    throw err;
  }
  // Reached only when the run ended on its own — `--for` elapsed, or
  // cloudflared died. A Ctrl-C exits from the handler above instead. The state
  // file is cleared here too, or an instance that closed its own tunnel would
  // leave `paddock status` describing a process that no longer exists.
  await removeState(stateDir).catch((e) =>
    console.error(`paddock: could not clear state file (${String(e)})`),
  );
  process.exit(code);
}
