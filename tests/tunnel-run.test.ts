import { expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentStore } from "@server/state/store";
import type { Tunnel } from "@server/tunnel/cloudflared";
import { COOKIE_NAME, Pairing } from "@server/tunnel/pairing";
import { runTunnel, serveGated, type TunnelDeps } from "@server/tunnel/run";
import { Hub } from "@server/ws/hub";

const PUBLIC_URL = "https://quiet-harbor-8f31.trycloudflare.com";

/** The app, hub and store the two listeners share. Never a real herdr. */
function base(): Omit<TunnelDeps, "port"> {
  const app = new Hono();
  app.get("/api/agents", (c) => c.json({ agents: [] }));
  app.get("/", (c) => c.html("<h1>dashboard</h1>"));
  return {
    app,
    hub: new Hub({ now: () => 0 }),
    hostId: "dev-box",
    store: new AgentStore("dev-box"),
    pairing: new Pairing({ now: () => 0 }),
  };
}

function harness() {
  const d = base();
  // Ephemeral: the OS picks the port, so the suite cannot collide with a
  // developer's own `paddock tunnel` or with another test file.
  const server = serveGated({ ...d, port: 0 });
  return { server, pairing: d.pairing, base: `http://127.0.0.1:${server.port}` };
}

/**
 * Swap the two console channels `runTunnel` writes on, so the suite's output
 * stays readable AND the tests can assert that a failure was reported rather
 * than swallowed. Restored in a `finally` at every call site — a test that
 * threw while console.error was a collector would take the runner's own
 * diagnostics with it.
 */
function capture() {
  const said: string[] = [];
  const realInfo = console.info;
  const realError = console.error;
  console.info = (...a: unknown[]) => { said.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { said.push(a.join(" ")); };
  return {
    said,
    text: () => said.join("\n"),
    restore: () => { console.info = realInfo; console.error = realError; },
  };
}

test("the gated listener refuses an unpaired API request", async () => {
  const { server, base: at } = harness();
  try {
    expect((await fetch(`${at}/api/agents`)).status).toBe(401);
  } finally { server.stop(); }
});

test("the gated listener refuses an unpaired WebSocket upgrade", async () => {
  // The upgrade never reaches app.fetch, so a Hono middleware alone cannot
  // gate it. This asserts the listener's own fetch consults `decide` FIRST.
  const { server, base: at } = harness();
  try {
    const res = await fetch(`${at}/ws`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(401);
  } finally { server.stop(); }
});

test("a paired session reaches the dashboard", async () => {
  const { server, pairing, base: at } = harness();
  try {
    const r = pairing.attempt(pairing.current().code);
    if (r.kind !== "paired") throw new Error("unreachable");
    const res = await fetch(`${at}/`, {
      headers: { accept: "text/html", cookie: `${COOKIE_NAME}=${r.token}` },
    });
    expect(await res.text()).toContain("dashboard");
  } finally { server.stop(); }
});

test("a navigation with no session gets the pairing form", async () => {
  const { server, base: at } = harness();
  try {
    const res = await fetch(`${at}/`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<form");
  } finally { server.stop(); }
});

/** A `startTunnel` that never spawns anything. No test may reach cloudflared. */
function fakeTunnel(o: {
  exited?: Promise<number>;
  stop?: () => Promise<void>;
  onPort?: (p: number) => void;
}): TunnelDeps["startTunnel"] {
  return async (opts) => {
    o.onPort?.(opts.port);
    const t: Tunnel = {
      url: PUBLIC_URL,
      exited: o.exited ?? new Promise<number>(() => {}),
      stop: o.stop ?? (async () => {}),
    };
    return t;
  };
}

test("a child that dies on its own ends the run non-zero, even having exited 0", async () => {
  const urls: (string | null)[] = [];
  let stopped = 0;
  const c = capture();
  let code: number;
  try {
    code = await runTunnel({
      ...base(),
      port: 0,
      startTunnel: fakeTunnel({
        exited: Promise.resolve(0),
        stop: async () => { stopped += 1; },
      }),
      setPublicUrl: (u) => urls.push(u),
    });
  } finally { c.restore(); }

  // A tunnel that vanished is a failure whatever exit code the child chose.
  expect(code).toBe(1);
  expect(stopped).toBe(1);
  // The notifier must stop handing out a URL that no longer resolves.
  expect(urls).toEqual([PUBLIC_URL, null]);
  expect(c.text()).toContain("cloudflared exited 0");
});

test("--for elapsing closes both sides and ends the run at 0", async () => {
  const urls: (string | null)[] = [];
  let gatedPort = 0;
  let stopped = 0;
  const c = capture();
  let code: number;
  try {
    code = await runTunnel({
      ...base(),
      port: 0,
      deadlineMs: 5,
      startTunnel: fakeTunnel({
        onPort: (p) => { gatedPort = p; },
        stop: async () => { stopped += 1; },
      }),
      setPublicUrl: (u) => urls.push(u),
    });
  } finally { c.restore(); }

  expect(code).toBe(0);
  expect(stopped).toBe(1);
  expect(urls.at(-1)).toBeNull();
  // The gated listener is gone with it: a deadline that closed the tunnel but
  // left the second port bound would keep a listener nobody is watching.
  await expect(fetch(`http://127.0.0.1:${gatedPort}/api/agents`)).rejects.toThrow();
});

test("runTunnel installs NO signal handler of its own", async () => {
  // THE regression guard for the orphaned-cloudflared bug. index.ts already
  // registers SIGINT/SIGTERM handlers that call process.exit(0); a second
  // handler here would race them, and index.ts's would very likely exit the
  // process before `tunnel.stop()` had finished — leaving a PUBLIC URL alive
  // after the paddock that created it died. There must be exactly one handler,
  // and runTunnel's teardown reaches it through `registerShutdown`.
  const before = {
    int: process.listenerCount("SIGINT"),
    term: process.listenerCount("SIGTERM"),
  };
  // A container, not a bare `let`: TypeScript narrows a `let` assigned only
  // inside a callback to `null` at every later read, which makes the call
  // below a type error rather than the thing under test.
  const reg: { teardown: (() => Promise<void>) | null } = { teardown: null };
  const c = capture();
  try {
    const run = runTunnel({
      ...base(),
      port: 0,
      startTunnel: fakeTunnel({}),
      registerShutdown: (fn) => { reg.teardown = fn; },
    });
    await Bun.sleep(10); // let the fake tunnel resolve and register

    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
    expect(reg.teardown, "the teardown must be handed to the caller").not.toBeNull();

    await reg.teardown!();
    // The run promise is still pending — the process exits from index.ts's
    // handler in production — so it is deliberately not awaited here.
    void run;
  } finally { c.restore(); }
});

test("a stop() that fails is reported, and the rest of the teardown still runs", async () => {
  // Bun terminates the process on an unhandled rejection, so a teardown that
  // let `stop()`'s rejection escape would kill paddock MID-shutdown — the
  // orphaned-cloudflared failure by another route. Report, step past, finish.
  const urls: (string | null)[] = [];
  let gatedPort = 0;
  const reg: { teardown: (() => Promise<void>) | null } = { teardown: null };
  const c = capture();
  try {
    const run = runTunnel({
      ...base(),
      port: 0,
      startTunnel: fakeTunnel({
        onPort: (p) => { gatedPort = p; },
        stop: async () => { throw new Error("kill: no such process"); },
      }),
      setPublicUrl: (u) => urls.push(u),
      registerShutdown: (fn) => { reg.teardown = fn; },
    });
    await Bun.sleep(10);
    await reg.teardown!(); // must resolve, not reject
    void run;
  } finally { c.restore(); }

  expect(c.text()).toContain("kill: no such process");
  // Everything after the failed stop still happened.
  expect(urls.at(-1)).toBeNull();
  await expect(fetch(`http://127.0.0.1:${gatedPort}/api/agents`)).rejects.toThrow();
});
