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
import { StreamKeeper } from "@server/herdr/keeper";
import { AgentStore } from "@server/state/store";
import { Supervisor } from "@server/supervisor";
import { Hub, type HubClient } from "@server/ws/hub";

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
const hub = new Hub();

let herdrConnected = false;
let supervisor: Supervisor | null = null;
let demo: DemoSource | null = null;

if (DEMO) {
  // Every tick goes through the store, so `/api/agents` and a browser that
  // loads the page an hour in both see current state — not startup state.
  demo = createDemoSource({ store, onDelta: (d) => hub.queue(d) });
  store.replaceAll(demo.snapshot(), Date.now());
  demo.start();
  herdrConnected = true;
  console.info("paddock: demo mode — synthetic agents, no herdr connection");
} else {
  // The stream is the only long-lived connection. Requests each open their own.
  let keeper: StreamKeeper | null = null;

  const stream = new HerdrStream({
    path: socketPath,
    onEvent: (e) => supervisor?.handleEvent(e),
    onStateChange: (up) => {
      herdrConnected = up;
      console.info(`herdr event stream ${up ? "connected" : "disconnected"}`);
      // A drop we did not ask for: start recovering. HerdrStream only calls
      // this with `false` for a teardown nobody requested (see the `close:`
      // handler in src/server/herdr/socket.ts) — a routine resubscribe
      // replacing the stream does NOT land here, so this genuinely fires
      // only on a real drop, not on every ordinary agent start/exit.
      if (!up) keeper?.notifyClosed();
    },
  });
  const client = {
    request: <T,>(method: string, params?: object) => request<T>(socketPath, method, params),
    openStream: (subs: Subscription[]) => stream.open(subs),
  };
  supervisor = new Supervisor({ client, store, onDelta: (d) => hub.queue(d) });

  // The pane set after a herdr restart is usually IDENTICAL to what it was
  // before — same agents, dead socket. Supervisor.resubscribe() skips
  // re-opening the stream when the computed pane set matches what it already
  // believes is live, so invalidateSubscription() must run first to clear
  // that belief; otherwise refresh() would reconcile, compute the same key,
  // take the early return, and never re-open the stream at all.
  //
  // invalidateSubscription() is a plain synchronous setter with no mutex, and
  // it is called immediately here — not queued behind Supervisor's own
  // refreshLoop/refreshQueued coalescing the way concurrent refresh() calls
  // are. Because onStateChange(false) now fires only for a genuine drop (see
  // the comment above), this callback no longer runs on every routine
  // resubscribe, which removes the one case that made this race a near
  // certainty rather than a hypothetical. What remains reachable, though
  // narrow, is a genuine drop landing while an UNRELATED Supervisor.refresh()
  // — one started independently by handleEvent(), e.g. for a different pane's
  // event — is already between its resubscribe()'s openStream() await and its
  // post-await `openPaneKey` write: that write could still overwrite this
  // invalidation. Nothing here queues invalidateSubscription() itself behind
  // that in-flight loop, so the window is real, not eliminated by the
  // socket.ts fix — just made rare instead of routine.
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
  health: () => ({
    ok: true,
    hostId,
    agents: store.snapshot().length,
    clients: hub.clientCount,
    herdrConnected,
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
