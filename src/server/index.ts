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
import { Hub, type HubClient } from "@server/ws/hub";
import { buildIdFrom } from "@server/build-id";

const args = new Set(Bun.argv.slice(2));
const DEMO = args.has("--demo");
const PORT = Number(process.env.PADDOCK_PORT ?? 8787);
const HOSTNAME = "127.0.0.1"; // loopback only; exposure is the tunnel's job

for (const unimplemented of ["agent", "hub"]) {
  if (args.has(unimplemented)) {
    console.error(`paddock ${unimplemented}: not implemented — see docs/roadmap.md`);
    process.exit(2);
  }
}

const socketPath =
  process.env.PADDOCK_HERDR_SOCKET ?? join(homedir(), ".config", "herdr", "herdr.sock");

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

const hub = new Hub({ build: currentBuildId });

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
    onDelta: (d) => hub.queue(d),
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
    else console.error("failed to start against herdr:", err);
    process.exit(1);
  }
}

const app = createApp({
  store,
  hub,
  actions,
  health: () => ({
    ok: true,
    hostId,
    agents: store.snapshot().length,
    clients: hub.clientCount,
    // Demo mode has no herdr; otherwise this is the stream's own answer.
    herdrConnected: DEMO ? true : (stream?.connected ?? false),
    lastEventAt: supervisor?.lastEventAt ?? (demo ? Date.now() : null),
  }),
  staticDir: process.env.PADDOCK_STATIC_DIR ?? "dist",
});

interface WsData {
  client?: HubClient;
}

Bun.serve<WsData>({
  port: PORT,
  hostname: HOSTNAME,
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: {} });
      return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      const client: HubClient = { send: (d) => ws.send(d) };
      ws.data.client = client;
      hub.add(client);
      hub.sendSnapshot(client, hostId, store.snapshot());
    },
    close(ws) {
      const held = ws.data.client;
      if (held) hub.remove(held);
    },
    message() {
      // Read-only in v1: the browser sends nothing.
    },
  },
});

// A quiet system sends nothing at all, so without this the browser would
// declare a perfectly healthy link stale after 60s of idle agents.
hub.startHeartbeat();

console.info(`paddock listening on http://${HOSTNAME}:${PORT}`);
