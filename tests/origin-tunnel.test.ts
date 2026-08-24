import { expect, test } from "bun:test";
import { connect } from "node:net";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { COOKIE_NAME, Pairing } from "@server/tunnel/pairing";
import { serveGated } from "@server/tunnel/run";
import { Hub } from "@server/ws/hub";
import type { Agent } from "@shared/types";

/**
 * The three DEPLOYMENT SHAPES, through the real gated listener.
 *
 * `tests/origin-gate.test.ts` covers the two enforcement points in isolation.
 * This file answers the question an operator actually has: does my deployment
 * still work? Each test names the shape it stands for — the desk, a quick
 * tunnel, a named tunnel — because the same-origin rule is the one change in
 * this area that could turn a working phone into a read-only screen, and the
 * failure would appear on a device the suite never runs on.
 *
 * The gated listener rather than the plain app on purpose: a request from a
 * tunnel passes the PAIRING gate first and the origin gate second, and only
 * this shape exercises both in the order production runs them.
 */

const NOW = 1_700_000_000_000;
const TUNNEL_HOST = "apple-berry-cat-dog.trycloudflare.com";
const NAMED_HOST = "paddock.example.com";

const health = () => ({
  ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true,
  lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null,
  herdrProtocol: null, schemaWarning: null,
});

function agent(): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "docs-cleanup",
    task: "Tidy the README", state: "done", workspaceId: "w1",
    workspaceLabel: "docs", cwd: "/srv/project", harness: "claude",
    stateSince: NOW, stateSinceExact: true, updatedAt: NOW, acknowledgedAt: null, hasJournal: false,
  };
}

/**
 * A live gated listener whose allowlist is whatever the deployment knows.
 *
 * `publicHosts` is passed as the thunk `index.ts` passes, so what is under test
 * is the wiring an operator runs, not a value inlined for the convenience of
 * the assertion.
 */
function harness(publicHosts: readonly string[] = []) {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const pairing = new Pairing({ now: () => NOW });
  // The SAME thunk reaches the app's write middleware and the listener's `/ws`
  // upgrade, exactly as `index.ts` hands it to both. Passing it to only one is
  // the defect this file caught: writes and upgrades then answer to different
  // allowlists.
  const hosts = () => publicHosts;
  const app = createApp({
    store, pairing, now: () => NOW, health,
    hub: new Hub({ now: () => NOW }),
    publicHosts: hosts,
  });
  const server = serveGated({
    app, pairing, store,
    hub: new Hub({ now: () => NOW }),
    hostId: "dev-box",
    port: 0, // the OS picks, so the suite never collides with a real tunnel
    env: {},
    isTty: false,
    publicHosts: hosts,
  });
  const paired = pairing.attempt(pairing.current().code);
  if (paired.kind !== "paired") throw new Error("unreachable: a fresh code must pair");
  return { server, token: paired.token };
}

/**
 * A write as a browser on `origin` sends it, arriving with `host` as a proxy set
 * it — sent over a RAW SOCKET, not `fetch`.
 *
 * `fetch` silently drops a `Host` header (it is forbidden to script), so every
 * request it makes to a loopback listener claims a loopback host. An earlier
 * version of this file used it and every tunnel case passed as the DESK case:
 * green, and testing nothing it claimed to. Bytes on a socket are also exactly
 * what `cloudflared` puts there, so this is the faithful shape rather than a
 * clever one.
 */
function rawWrite(port: number, token: string, o: { host: string; origin: string }): Promise<number> {
  const body = "{}";
  const req = [
    "POST /api/agents/w1:p1/ack HTTP/1.1",
    `Host: ${o.host}`,
    `Origin: ${o.origin}`,
    `Cookie: ${COOKIE_NAME}=${token}`,
    "content-type: application/json",
    `content-length: ${body.length}`,
    "connection: close",
    "",
    body,
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port }, () => sock.write(req));
    let out = "";
    sock.on("data", (d) => { out += d.toString("latin1"); });
    sock.on("error", reject);
    sock.on("close", () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(out);
      if (status === null) reject(new Error(`no status line: ${out.slice(0, 120)}`));
      else resolve(Number(status[1]));
    });
  });
}

test("the desk still works: loopback, no public hostname known", async () => {
  const { server, token } = harness([]);
  try {
    const status = await rawWrite(server.port, token, {
      host: "127.0.0.1:8788",
      origin: "http://127.0.0.1:8788",
    });
    expect(status).toBe(200);
  } finally { server.stop(); }
});

test("a quick tunnel still works: the run's own hostname", async () => {
  // `paddock tunnel`. `publicHostsFrom` learns this hostname from the live
  // value, since it is never written to settings.json.
  const { server, token } = harness([TUNNEL_HOST]);
  try {
    const status = await rawWrite(server.port, token, {
      host: TUNNEL_HOST,
      origin: `https://${TUNNEL_HOST}`,
    });
    expect(status).toBe(200);
  } finally { server.stop(); }
});

test("a named tunnel still works: publicUrl's hostname", async () => {
  const { server, token } = harness([NAMED_HOST]);
  try {
    const status = await rawWrite(server.port, token, {
      host: NAMED_HOST,
      origin: `https://${NAMED_HOST}`,
    });
    expect(status).toBe(200);
  } finally { server.stop(); }
});

test("a named tunnel works with publicUrl unset — the allowlist is inactive", async () => {
  // The case that keeps `publicUrl` optional: an operator who does not use
  // Telegram has never had a reason to set it, and must not lose the reply path
  // for that. Same-origin is still enforced; only rebinding is uncovered.
  const { server, token } = harness([]);
  try {
    const status = await rawWrite(server.port, token, {
      host: NAMED_HOST,
      origin: `https://${NAMED_HOST}`,
    });
    expect(status).toBe(200);
  } finally { server.stop(); }
});

test("desk browsing survives a populated allowlist", async () => {
  // Setting a public URL must not break the loopback the operator uses at their
  // own machine, or `make dev`.
  const { server, token } = harness([NAMED_HOST]);
  try {
    const status = await rawWrite(server.port, token, {
      host: "127.0.0.1:8788",
      origin: "http://127.0.0.1:8788",
    });
    expect(status).toBe(200);
  } finally { server.stop(); }
});

test("a paired but cross-origin write is still refused", async () => {
  // Pairing proves the DEVICE reached the tunnel, never which page is asking.
  // A paired phone that later visits a hostile page must not become a lever on
  // the agents, so the origin gate has to sit behind the pairing gate rather
  // than being satisfied by it.
  const { server, token } = harness([TUNNEL_HOST]);
  try {
    const status = await rawWrite(server.port, token, {
      host: TUNNEL_HOST,
      origin: "https://evil.example",
    });
    expect(status).toBe(403);
  } finally { server.stop(); }
});

test("a publicUrl naming a hostname the deployment is NOT reached on locks out writes", async () => {
  // The one way this bites, recorded as a test so it is a known trade-off and
  // not a surprise: a stale or mistyped `publicUrl`, or a second legitimate
  // hostname for the same paddock, is refused even though Origin and Host
  // agree — which is exactly the rebinding protection working as designed,
  // pointed at the operator. `docs/gotchas.md` carries the symptom and the fix
  // (correct the value, or clear it); the refusal names both headers on stderr
  // so it is diagnosable rather than mysterious.
  const { server, token } = harness(["stale.example"]);
  try {
    const status = await rawWrite(server.port, token, {
      host: NAMED_HOST,
      origin: `https://${NAMED_HOST}`,
    });
    expect(status).toBe(403);
  } finally { server.stop(); }
});
