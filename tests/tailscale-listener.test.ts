import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import type { WebSocketHandler } from "bun";
import { startTailnetListener, tailnetHosts } from "@server/tailscale/listener";
import type { WsData } from "@server/ws/serve";

/**
 * The tailnet listener, through REAL sockets.
 *
 * `tests/tailscale-gate.test.ts` covers the decision in isolation. This file
 * covers the property that decision is worth nothing without: that it runs
 * BEFORE every route this listener serves, including the `/ws` upgrade, which
 * never reaches `app.fetch` and so could never be gated by app middleware.
 *
 * Requests go over a raw socket, not `fetch`, because `fetch` drops a scripted
 * `Host` header, and the `/ws` same-origin check reads `Host` — the same trap
 * `tests/origin-tunnel.test.ts` documents.
 */

const LOGIN = "operator@github";
const HOST = "dev-box.example-tailnet.ts.net";

let stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

function harness() {
  const calls: string[] = [];
  const opened: number[] = [];
  const app = {
    fetch(req: Request): Response {
      calls.push(new URL(req.url).pathname);
      return new Response("app", { status: 200 });
    },
  };
  const websocket: WebSocketHandler<WsData> = {
    open() { opened.push(1); },
    message() {},
    close() {},
  };
  const r = startTailnetListener({
    app, websocket, port: 0, login: LOGIN, publicHosts: () => tailnetHosts([], HOST),
  });
  if (!r.ok) throw new Error(`listener did not start: ${r.error}`);
  stops.push(r.stop);
  return { ...r, calls, opened };
}

/** One request as raw bytes; resolves to the status code and body. */
function raw(
  port: number,
  o: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const body = o.body ?? "";
  const headers: Record<string, string> = {
    Host: HOST,
    connection: "close",
    ...(body === "" ? {} : { "content-type": "application/json", "content-length": String(body.length) }),
    ...o.headers,
  };
  const lines = [
    `${o.method ?? "GET"} ${o.path} HTTP/1.1`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "",
    body,
  ];
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port }, () => sock.write(lines.join("\r\n")));
    let out = "";
    const finish = () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(out);
      if (m === null) return reject(new Error(`no status line: ${out.slice(0, 120)}`));
      const at = out.indexOf("\r\n\r\n");
      resolve({ status: Number(m[1]), body: at === -1 ? "" : out.slice(at + 4) });
    };
    sock.on("data", (d) => {
      out += d.toString("latin1");
      // A 101 never closes on its own; the head is all this test needs.
      if (/^HTTP\/1\.1 101/.test(out) && out.includes("\r\n\r\n")) {
        sock.destroy();
        finish();
      }
    });
    sock.on("error", reject);
    sock.on("close", finish);
  });
}

const WS_HEADERS = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version": "13",
  Origin: `https://${HOST}`,
};

test("forwards an allowed request to the app", async () => {
  const h = harness();
  const res = await raw(h.port, { path: "/", headers: { "Tailscale-User-Login": LOGIN } });
  expect(res.status).toBe(200);
  expect(res.body).toContain("app");
  expect(h.calls).toEqual(["/"]);
});

test("403s a request without identity before the app runs", async () => {
  const h = harness();
  const res = await raw(h.port, { path: "/api/health" });
  expect(res.status).toBe(403);
  expect(JSON.parse(res.body).detail).toStartWith("tailnet: ");
  expect(h.calls).toEqual([]);
});

test("403s a different login before the app runs", async () => {
  const h = harness();
  const res = await raw(h.port, { path: "/", headers: { "Tailscale-User-Login": "intruder@github" } });
  expect(res.status).toBe(403);
  expect(h.calls).toEqual([]);
});

// Every shape of route this listener serves: the static shell and the service
// worker (which an application token would have broken — CLAUDE.md), the MCP
// endpoint, and an action that types into an agent. None may reach the app.
for (const r of [
  { method: "GET", path: "/" },
  { method: "GET", path: "/sw.js" },
  { method: "POST", path: "/mcp", body: "{}" },
  { method: "POST", path: "/api/agents/x/key", body: "{}" },
]) {
  test(`${r.method} ${r.path} without identity is 403 and never reaches the app`, async () => {
    const h = harness();
    const res = await raw(h.port, r);
    expect(res.status).toBe(403);
    expect(h.calls).toEqual([]);
  });
}

test(`/ws upgrade with the allowed login and Origin https://${HOST} and Host ${HOST} is upgraded`, async () => {
  const h = harness();
  const res = await raw(h.port, { path: "/ws", headers: { ...WS_HEADERS, "Tailscale-User-Login": LOGIN } });
  expect(res.status).toBe(101);
  expect(h.calls).toEqual([]);
});

test("/ws without identity is 403 and never upgraded", async () => {
  const h = harness();
  const res = await raw(h.port, { path: "/ws", headers: WS_HEADERS });
  expect(res.status).toBe(403);
  expect(JSON.parse(res.body).detail).toStartWith("tailnet: ");
  // Give a wrongly-accepted socket the chance to open before asserting it did not.
  await Bun.sleep(20);
  expect(h.opened).toEqual([]);
  expect(h.calls).toEqual([]);
});

test("/ws from a foreign Origin is refused even with the allowed login", async () => {
  const h = harness();
  const res = await raw(h.port, {
    path: "/ws",
    headers: { ...WS_HEADERS, Origin: "https://evil.example.net", "Tailscale-User-Login": LOGIN },
  });
  expect(res.status).toBe(403);
  expect(h.opened).toEqual([]);
});

test("binds 127.0.0.1 regardless of PADDOCK_HOST", () => {
  const before = process.env.PADDOCK_HOST;
  process.env.PADDOCK_HOST = "0.0.0.0";
  try {
    const h = harness();
    expect(h.hostname).toBe("127.0.0.1");
  } finally {
    if (before === undefined) delete process.env.PADDOCK_HOST;
    else process.env.PADDOCK_HOST = before;
  }
});

test("tailnetHosts appends the tailnet host to the shared list, deduplicated", () => {
  expect(tailnetHosts([], HOST)).toEqual([HOST]);
  expect(tailnetHosts(["paddock.example.com"], HOST)).toEqual(["paddock.example.com", HOST]);
  expect(tailnetHosts([HOST], HOST)).toEqual([HOST]);
});

test("port in use → {ok:false}, not a throw", () => {
  const h = harness();
  const again = startTailnetListener({
    app: { fetch: () => new Response("app") },
    websocket: { message() {} },
    port: h.port,
    login: LOGIN,
    publicHosts: () => [],
  });
  expect(again.ok).toBe(false);
  if (!again.ok) expect(again.error).toContain(String(h.port));
});

/**
 * The default 8787 listener must never read Tailscale identity headers: there
 * the header would be trusted from any local caller and from cloudflared. The
 * gate is therefore referenced from exactly two files — its own and this
 * listener's — and a new call site anywhere else fails here.
 */
test("tailnetRefusal is used only by the tailnet listener", async () => {
  const glob = new Bun.Glob("src/**/*.{ts,tsx}");
  const users: string[] = [];
  for await (const f of glob.scan(".")) {
    if ((await Bun.file(f).text()).includes("tailnetRefusal")) users.push(f);
  }
  expect(users.sort()).toEqual(["src/server/tailscale/gate.ts", "src/server/tailscale/listener.ts"]);
});
