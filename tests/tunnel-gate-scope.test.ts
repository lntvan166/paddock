import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { COOKIE_NAME, Pairing } from "@server/tunnel/pairing";
import { serveGated } from "@server/tunnel/run";
import { Hub } from "@server/ws/hub";

const NOW = 1_700_000_000_000;

const health = () => ({
  ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: true,
  lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null,
});

/**
 * The PRODUCTION objects, both times — `createApp` and `serveGated`, exactly as
 * `index.ts` builds them. An earlier version of this file asserted that a bare
 * `Hono` with no middleware answers 200, which is true of every Hono app ever
 * written and guarded nothing; `docs/gotchas.md` records tests that proved
 * nothing as a failure this repo has actually suffered.
 *
 * What is under test is the SCOPE of the gate: it belongs to the tunnel's
 * listener and to nothing else. If it ever leaked onto the desk's 8787, every
 * desk browser and every `make dev` session would start demanding a pairing
 * code, and the symptom points nowhere near the cause.
 */
function plainApp() {
  // No `pairing`, which is precisely how `index.ts:402` builds the 8787 app.
  return createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    health,
  });
}

function gatedListener() {
  const pairing = new Pairing({ now: () => NOW });
  const app = createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    health,
    pairing,
  });
  // Port 0: the OS picks, so the suite cannot collide with a developer's own
  // `paddock tunnel` or with another test file.
  const server = serveGated({
    app,
    hub: new Hub({ now: () => NOW }),
    hostId: "dev-box",
    store: new AgentStore("dev-box"),
    pairing,
    port: 0,
  });
  return { server, pairing, at: `http://127.0.0.1:${server.port}` };
}

test("the desk listener's app is ungated: no cookie, no pairing form, no 401", async () => {
  const app = plainApp();

  const api = await app.request("/api/agents");
  expect(api.status).toBe(200);
  // Not merely "not 401": a gate that leaked would also hand out a session
  // cookie or clear one, and neither belongs on the desk listener.
  expect(api.headers.get("set-cookie")).toBeNull();

  // A navigation is the shape that would get the pairing PAGE (200 + a form)
  // rather than a 401, so a leak here is the easiest one to miss.
  const nav = await app.request("/api/agents", { headers: { accept: "text/html" } });
  expect(nav.status).toBe(200);
  expect(await nav.text()).not.toContain("<form");

  // And the way IN does not exist here either: no pairing dep, no pairing
  // routes. A desk paddock must not offer a flow it could not gate.
  expect((await app.request("/pair", { method: "POST" })).status).toBe(404);
  expect((await app.request("/api/pair/invite", { method: "POST" })).status).toBe(404);
});

test("the same request on the tunnel's listener is gated, and a session opens it", async () => {
  // The other half of the scope claim, over a real socket. `tunnel-run.test.ts`
  // covers the upgrade and the pairing page against the same listener; this
  // asserts the identical request that answered 200 above answers 401 here.
  const { server, pairing, at } = gatedListener();
  try {
    expect((await fetch(`${at}/api/agents`)).status).toBe(401);

    const r = pairing.attempt(pairing.current().code);
    if (r.kind !== "paired") throw new Error("unreachable");
    const paired = await fetch(`${at}/api/agents`, {
      headers: { cookie: `${COOKIE_NAME}=${r.token}` },
    });
    expect(paired.status).toBe(200);
  } finally { server.stop(); }
});
