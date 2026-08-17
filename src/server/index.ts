import { homedir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/routes";
import { DemoSource, DEMO_HOST_ID } from "@server/demo";
import {
  HerdrStream,
  ProtocolMismatchError,
  checkProtocol,
  request,
  type Subscription,
} from "@server/herdr/socket";
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
  demo = new DemoSource({ onDelta: (d) => hub.queue(d) });
  store.replaceAll(demo.snapshot(), Date.now());
  demo.start();
  herdrConnected = true;
  console.info("paddock: demo mode — synthetic agents, no herdr connection");
} else {
  // The stream is the only long-lived connection. Requests each open their own.
  const stream = new HerdrStream({
    path: socketPath,
    onEvent: (e) => supervisor?.handleEvent(e),
    onStateChange: (up) => {
      herdrConnected = up;
      console.info(`herdr event stream ${up ? "connected" : "disconnected"}`);
    },
  });
  const client = {
    request: <T,>(method: string, params?: object) => request<T>(socketPath, method, params),
    openStream: (subs: Subscription[]) => stream.open(subs),
  };
  supervisor = new Supervisor({ client, store, onDelta: (d) => hub.queue(d) });
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

console.info(`paddock listening on http://${HOSTNAME}:${PORT}`);
