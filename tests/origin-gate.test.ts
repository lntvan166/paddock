import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import { tryUpgradeWs, type WsData } from "@server/ws/serve";
import type { Server } from "bun";
import type { Agent } from "@shared/types";

/**
 * The two ENFORCEMENT POINTS, as opposed to `tests/origin.test.ts`, which pins
 * the rule. Both are the single shared definition for their transport — one
 * Hono middleware that both listeners inherit with the app, and the one `/ws`
 * interception `ws/serve.ts` exists so there is only one of — so a hole here is
 * a hole on the desk's 8787 and on the tunnel's gated listener at once.
 *
 * `app.request()` builds a request for `http://localhost/…`, so `http://localhost`
 * is the same-origin case throughout this file.
 */

const NOW = 1_700_000_000_000;

const health = () => ({
  ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true,
  lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null,
  herdrProtocol: null, schemaWarning: null,
});

function agent(state: Agent["state"] = "blocked"): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state, workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project",
    stateSince: NOW, updatedAt: NOW, acknowledgedAt: null, hasJournal: false,
  };
}

function harness(state: Agent["state"] = "blocked") {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent(state)], NOW);
  const calls: string[] = [];
  const actions = {
    async readOutput() { calls.push("readOutput"); return { lines: ["out"], source: "visible" as const }; },
    async readDetection() { calls.push("readDetection"); return ""; },
    async sendOptionKey(_t: string, k: string) { calls.push(`key:${k}`); },
    async sendNavKey(_t: string, k: string) { calls.push(`nav:${k}`); },
    async sendReply(_t: string, text: string) { calls.push(`reply:${text}`); },
    async waitUntilUnblocked() { calls.push("wait"); },
  };
  const app = createApp({
    store, actions, now: () => NOW, health,
    hub: new Hub({ now: () => NOW }),
  });
  return { app, calls, store };
}

const post = (app: ReturnType<typeof createApp>, path: string, origin: string | null, body: object = {}) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin === null ? {} : { origin }),
    },
    body: JSON.stringify(body),
  });

test("a cross-origin reply is refused, and never reaches the agent", () => {
  // THE hole this work closes. `/text` types arbitrary text into a live coding
  // agent, and `jsonBody` never looks at the content type — so before this gate
  // an `enctype="text/plain"` form on any page the operator visited could post
  // valid JSON here with no preflight. The second assertion is the one that
  // matters: a 403 that still typed the text would be no fix at all.
  return (async () => {
    const { app, calls } = harness();
    const res = await post(app, "/api/agents/w1:p1/text", "https://evil.example", { text: "rm -rf /" });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  })();
});

test("the refusal names cross-origin as the reason", async () => {
  const { app } = harness();
  const res = await post(app, "/api/agents/w1:p1/text", "https://evil.example", { text: "hi" });
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("cross-origin");
});

test("a same-origin reply still works", async () => {
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w1:p1/text", "http://localhost", { text: "yes" });
  expect(res.status).toBe(200);
  expect(calls).toContain("reply:yes");
});

test("a reply with no Origin still works — the command line is not a CSRF vector", async () => {
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w1:p1/text", null, { text: "yes" });
  expect(res.status).toBe(200);
  expect(calls).toContain("reply:yes");
});

test("every write verb is covered, not just the ones with an actions dep", async () => {
  // `/ack` touches only paddock's own store and the hub, and is registered even
  // in demo mode. It must be gated by the same middleware — the guard belongs to
  // the verb, not to a route's dependencies. `done`, because /ack refuses any
  // other state with a 409 of its own and this test is about the gate.
  const { app } = harness("done");
  expect((await post(app, "/api/agents/w1:p1/ack", "https://evil.example")).status).toBe(403);
  expect((await post(app, "/api/agents/w1:p1/ack", "http://localhost")).status).toBe(200);
});

test("a foreign Origin on a READ is allowed", async () => {
  // Deliberate, and load-bearing twice over. Browsers omit `Origin` on
  // same-origin GETs, so a GET guard would have to accept a missing one anyway
  // and would gate nothing. And a cross-origin GET cannot READ the response —
  // paddock sends no CORS headers — so there is nothing to protect. Guarding
  // GETs is how `/sw.js` and the app shell would break instead.
  const { app } = harness();
  const res = await app.request("/api/agents", { headers: { origin: "https://evil.example" } });
  expect(res.status).toBe(200);
});

/** A `Server` that records whether `upgrade` was reached at all. */
function fakeServer(): { srv: Server<WsData>; calls: { upgrades: number } } {
  const calls = { upgrades: 0 };
  const srv = {
    upgrade() {
      calls.upgrades += 1;
      return true;
    },
  } as unknown as Server<WsData>;
  return { srv, calls };
}

const upgradeReq = (origin: string | null) =>
  new Request("http://127.0.0.1:8787/ws", {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      ...(origin === null ? {} : { origin }),
    },
  });

test("a cross-origin upgrade is refused before `upgrade` is called", () => {
  // The socket sends the whole snapshot in `open`, so a refusal that arrived
  // after the upgrade would have already disclosed every agent's screen.
  const { srv, calls } = fakeServer();
  const res = tryUpgradeWs(upgradeReq("https://evil.example"), srv);
  expect(res).toBeInstanceOf(Response);
  expect((res as Response).status).toBe(403);
  expect(calls.upgrades).toBe(0);
});

test("an upgrade with no Origin is refused", () => {
  // Browsers always send it on a handshake, so this is `websocat` or a script —
  // and every uid on the host can reach a TCP port, unlike herdr's socket file.
  const { srv, calls } = fakeServer();
  const res = tryUpgradeWs(upgradeReq(null), srv);
  expect((res as Response).status).toBe(403);
  expect(calls.upgrades).toBe(0);
});

test("a same-origin upgrade proceeds", () => {
  const { srv, calls } = fakeServer();
  const res = tryUpgradeWs(upgradeReq("http://127.0.0.1:8787"), srv);
  // `undefined` is Bun's own signal that the response IS the upgrade.
  expect(res).toBeUndefined();
  expect(calls.upgrades).toBe(1);
});

test("a request that is not /ws is still not this route's business", () => {
  // The guard must not turn a fall-through into a refusal: `null` is how the
  // caller learns the request belongs to the app.
  const { srv } = fakeServer();
  expect(tryUpgradeWs(new Request("http://127.0.0.1:8787/api/agents"), srv)).toBeNull();
});
