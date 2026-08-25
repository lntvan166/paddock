import { expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentStore } from "@server/state/store";
import type { Child, Tunnel } from "@server/tunnel/cloudflared";
import { COOKIE_NAME, Pairing } from "@server/tunnel/pairing";
import {
  gatedPortInUseMessage, runTunnel, serveGated, wantsCompact, wantsQr, type TunnelDeps,
} from "@server/tunnel/run";
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
    // NEVER the real environment or the real terminal. Under a pty, a tty
    // draw writes `ESC[H ESC[J` — home, then clear to end of screen — which
    // wipes the test runner's own output and with it any failure printed
    // above this point.
    env: {},
    isTty: false,
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
  /** Hands back cloudflared's own log sink, so a test can emit lines on it. */
  onSink?: (emit: (line: string) => void) => void;
}): TunnelDeps["startTunnel"] {
  return async (opts) => {
    o.onPort?.(opts.port);
    if (opts.onLog) o.onSink?.(opts.onLog);
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
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
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
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
  const c = capture();
  let cleanly: boolean | undefined;
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
    cleanly = await reg.teardown!(); // must resolve, not reject
    void run;
  } finally { c.restore(); }

  expect(c.text()).toContain("kill: no such process");
  // Reported AND carried out: `index.ts`'s signal handler turns this `false`
  // into a non-zero exit. A cloudflared that could not be killed is a public
  // URL still live with no paddock behind it, and telling a wrapper script or
  // a systemd unit that THAT was a clean shutdown is the failure this whole
  // path exists to prevent.
  expect(cleanly).toBe(false);
  // Everything after the failed stop still happened.
  expect(urls.at(-1)).toBeNull();
  await expect(fetch(`http://127.0.0.1:${gatedPort}/api/agents`)).rejects.toThrow();
  // A second teardown must not launder the failure into a clean answer.
  expect(await reg.teardown!()).toBe(false);
});

test("--for elapsing on a child that cannot be killed ends the run non-zero", async () => {
  // The exit status is part of the error surface. `--for` is the one path that
  // ends at 0 when all is well, so it is the one path where a kill that failed
  // is the difference between "the tunnel is closed" and "the URL may still be
  // up" — and a script reading `$?` has nothing else to go on.
  const c = capture();
  let code: number;
  try {
    code = await runTunnel({
      ...base(),
      port: 0,
      deadlineMs: 5,
      startTunnel: fakeTunnel({
        stop: async () => { throw new Error("kill: operation not permitted"); },
      }),
    });
  } finally { c.restore(); }

  expect(code).toBe(1);
  expect(c.text()).toContain("the tunnel may still be up");
  // Still reported as the elapsed deadline it was, not as a crash.
  expect(c.text()).toContain("elapsed");
});

test("a teardown that stopped everything reports so, and --for stays 0", async () => {
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
  const c = capture();
  try {
    const run = runTunnel({
      ...base(),
      port: 0,
      startTunnel: fakeTunnel({}),
      registerShutdown: (fn) => { reg.teardown = fn; },
    });
    await Bun.sleep(10);
    expect(await reg.teardown!()).toBe(true);
    void run;
  } finally { c.restore(); }
});

test("a teardown during startup kills the child cloudflared already spawned", async () => {
  // The other half of the orphan window. `runTunnel` cannot register a
  // teardown for a child it has no handle on, and `startTunnel` may spend tens
  // of seconds waiting for a URL — so it hands the child over at spawn time
  // via `onSpawn`, and the teardown must reap it even though no `Tunnel` was
  // ever produced. Before this, a `kill -TERM` in that window left cloudflared
  // running with a public URL and no paddock behind it.
  const killed: (number | string | undefined)[] = [];
  const urls: (string | null)[] = [];
  let resolveExit: (n: number) => void = () => {};
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
  const c = capture();
  try {
    const run = runTunnel({
      ...base(),
      port: 0,
      registerShutdown: (fn) => { reg.teardown = fn; },
      startTunnel: async (opts) => {
        const spawned: Child = {
          stdout: null,
          stderr: null,
          exited: new Promise<number>((r) => { resolveExit = r; }),
          kill: (sig) => { killed.push(sig); resolveExit(0); },
        };
        opts.onSpawn?.(spawned);
        // Never publishes a URL: the state the teardown has to cope with.
        return new Promise<Tunnel>(() => {});
      },
      setPublicUrl: (u) => urls.push(u),
    });
    await Bun.sleep(10);
    expect(reg.teardown, "the teardown must be registered BEFORE the URL").not.toBeNull();
    await reg.teardown!();
    void run; // still pending: in production the process exits from index.ts
  } finally { c.restore(); }

  expect(killed).toEqual(["SIGTERM"]);
  // Said out loud, so a log does not read as a clean close of a live tunnel.
  expect(c.text()).toContain("before it published a URL");
  expect(urls).toEqual([null]);
});

test("a gated port that is already taken is a refusal, not an escaping throw", async () => {
  // The throw used to escape runTunnel and end the process from inside a
  // top-level await in index.ts, skipping BOTH removeState calls — so a stale
  // paddock.state.json survived and the next `paddock status` reported a
  // process that was gone. A refusal has to come back as an exit code so the
  // caller's ordinary exit path runs.
  const squatter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("mine") });
  const taken = squatter.port!;
  let started = 0;
  const c = capture();
  let code: number;
  try {
    code = await runTunnel({
      ...base(),
      port: taken,
      startTunnel: async () => {
        started += 1;
        throw new Error("no child may be spawned for a listener that never bound");
      },
    });
  } finally {
    c.restore();
    squatter.stop(true);
  }

  expect(code).toBe(1);
  // No child was spawned for a listener that never came up.
  expect(started).toBe(0);
  expect(c.text()).toContain(`port ${taken} is already in use`);
  // The variable that would actually help, not the dashboard's own.
  expect(c.text()).toContain("PADDOCK_TUNNEL_PORT");
  expect(c.text()).not.toContain("PADDOCK_PORT=");
});

test("the in-use message names the tunnel port and the variable that moves it", () => {
  const m = gatedPortInUseMessage(8788);
  expect(m).toContain("8788");
  expect(m).toContain("PADDOCK_TUNNEL_PORT=8789");
  // Pure: asserting the wording must not need a bound port.
  expect(m).toContain("127.0.0.1:8788");
});

// --- cloudflared output vs. the repainted display ---------------------------
//
// Both write to stdout. `draw()` homes the cursor and clears to end of screen
// once a second, so a cloudflared line printed in between flashed and was
// erased. Suppressing it outright is not an option — its stderr is the only
// place a tunnel failure explains itself — so it is buffered and printed where
// it answers a question.

/** Collects `process.stdout.write` so a tty test cannot wipe the runner's output. */
function captureStdout() {
  const writes: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  // Narrow stub: these tests only ever write strings through it.
  process.stdout.write = ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { writes, text: () => writes.join(""), restore: () => { process.stdout.write = real; } };
}

test("a piped run keeps every cloudflared line — nothing overwrites them there", async () => {
  const c = capture();
  // An object, not a `let`: assigned inside a callback, which control-flow
  // analysis cannot see, so a nullable local narrows to `never` at the call.
  const sink: { emit: ((l: string) => void) | null } = { emit: null };
  try {
    await runTunnel({
      ...base(), // isTty: false
      port: 0,
      startTunnel: fakeTunnel({
        onSink: (e) => {
          sink.emit = e;
          e("INF Registered tunnel connection");
        },
        exited: Bun.sleep(15).then(() => 0),
      }),
    });
  } finally { c.restore(); }
  expect(sink.emit, "startTunnel must be handed a log sink").not.toBeNull();
  expect(c.text()).toContain("[cloudflared] INF Registered tunnel connection");
});

test("on a tty the lines are held back, then printed when the child dies", async () => {
  const out = captureStdout();
  const c = capture();
  let code: number;
  try {
    let release: (n: number) => void = () => {};
    const exited = new Promise<number>((r) => { release = r; });
    const run = runTunnel({
      ...base(),
      isTty: true,
      port: 0,
      startTunnel: fakeTunnel({
        onSink: (emit) => {
          // Emitted after the display has taken the screen.
          void Bun.sleep(5).then(() => {
            emit("INF Initiating graceful shutdown due to signal interrupt");
            release(1);
          });
        },
        exited,
      }),
    });
    code = await run;
  } finally { c.restore(); out.restore(); }

  expect(code).toBe(1);
  // The diagnosis rides along with the exit code, which alone explains nothing.
  expect(c.text()).toContain("cloudflared exited 1");
  expect(c.text()).toContain("graceful shutdown due to signal interrupt");
  // And it did NOT go to the screen the display owns.
  expect(out.text()).not.toContain("graceful shutdown");
});

test("the held lines are capped, keeping the tail — the last lines say why", async () => {
  const out = captureStdout();
  const c = capture();
  try {
    let release: (n: number) => void = () => {};
    const exited = new Promise<number>((r) => { release = r; });
    await runTunnel({
      ...base(),
      isTty: true,
      port: 0,
      startTunnel: fakeTunnel({
        onSink: (emit) => {
          void Bun.sleep(5).then(() => {
            for (let i = 0; i < 60; i++) emit(`line ${i}`);
            release(1);
          });
        },
        exited,
      }),
    });
  } finally { c.restore(); out.restore(); }

  const text = c.text();
  expect(text).toContain("the last 50 line(s) from cloudflared");
  expect(text).toContain("line 59");
  // The oldest fell off. `line 9` would also match `line 9x`, so anchor it.
  expect(text).not.toContain("[cloudflared] line 0");
});

// `^C` reaches cloudflared straight from the tty, so its shutdown line is
// already written by the time paddock's teardown runs. The block on screen
// still reads `tunnel up`, and leaving it there makes the display assert the
// one thing that has just stopped being true.
test("teardown clears the block instead of leaving it claiming the tunnel is up", async () => {
  const out = captureStdout();
  const c = capture();
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
  try {
    void runTunnel({
      ...base(),
      isTty: true,
      port: 0,
      startTunnel: fakeTunnel({}),
      registerShutdown: (fn) => { reg.teardown = fn; },
    });
    await Bun.sleep(10);
    expect(out.text()).toContain("tunnel up");

    const marker = out.writes.length;
    await reg.teardown!();
    // Home, then clear to end of screen — after the last frame, not part of it.
    expect(out.writes.slice(marker).join("")).toContain("\x1b[H\x1b[J");
  } finally { c.restore(); out.restore(); }
});

// A `^C` reaches cloudflared straight from the tty, so the child dies at the
// same moment paddock's teardown runs — and the race in `runTunnel` used to
// take that death for an unexplained one. The operator got
// `cloudflared exited 143 — the URL is gone` plus a 50-line tail, which on a
// long-lived tunnel is the last thing cloudflared happened to say: its
// SUCCESSFUL startup prechecks, printed as if they explained a crash.
test("a requested stop is not reported as a tunnel that failed", async () => {
  const out = captureStdout();
  const c = capture();
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
  const sink: { emit: ((l: string) => void) | null } = { emit: null };
  let code: number;
  try {
    let release: (n: number) => void = () => {};
    const exited = new Promise<number>((r) => { release = r; });
    const run = runTunnel({
      ...base(),
      isTty: true,
      port: 0,
      startTunnel: fakeTunnel({
        onSink: (emit) => {
          sink.emit = emit;
          // Held back while the display owns the screen: the buffer a real run
          // arrives at teardown with.
          void Bun.sleep(5).then(() => emit("INF Registered tunnel connection"));
        },
        exited,
        // The child is already on its way out by the time the kill lands.
        stop: async () => {
          sink.emit?.("INF Initiating graceful shutdown due to signal interrupt");
          release(143);
        },
      }),
      registerShutdown: (fn) => { reg.teardown = fn; },
    });
    await Bun.sleep(10);
    expect(await reg.teardown!()).toBe(true);
    code = await run;
  } finally { c.restore(); out.restore(); }

  const text = c.text();
  // Not silence: cloudflared's own account of the shutdown still comes through,
  // and the teardown's closing line is the report.
  expect(text).toContain("graceful shutdown due to signal interrupt");
  expect(text).toContain("tunnel closed");
  // 143 is the signal the operator sent, and the URL going away is what they
  // asked for. Neither is a failure to warn about.
  expect(text).not.toContain("the URL is gone");
  // And there is nothing to diagnose, so no tail.
  expect(text).not.toContain("line(s) from cloudflared");
  expect(code).toBe(0);
});

test("a requested stop whose kill failed still ends the run non-zero", async () => {
  // The one thing that must survive the quieting above. A `stop()` that was
  // refused means a cloudflared may still be holding a public URL with no
  // paddock behind it, and the exit status is all a wrapper script has.
  const out = captureStdout();
  const c = capture();
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
  let code: number;
  try {
    let release: (n: number) => void = () => {};
    const exited = new Promise<number>((r) => { release = r; });
    const run = runTunnel({
      ...base(),
      isTty: true,
      port: 0,
      startTunnel: fakeTunnel({
        exited,
        stop: async () => {
          release(143);
          throw new Error("kill: operation not permitted");
        },
      }),
      registerShutdown: (fn) => { reg.teardown = fn; },
    });
    await Bun.sleep(10);
    expect(await reg.teardown!()).toBe(false);
    code = await run;
  } finally { c.restore(); out.restore(); }

  expect(code).toBe(1);
  expect(c.text()).toContain("the tunnel may still be up");
});

test("the QR is suppressed for each reason independently", () => {
  // These four are the whole suppression contract. Each is checked alone so a
  // change that collapses two of them into one cannot pass by accident.
  expect(wantsQr({ colour: false, columns: 80, rows: 40 })).toBe(false); // not a tty, or NO_COLOR
  expect(wantsQr({ colour: true, columns: 36, rows: 40 })).toBe(false);  // too narrow
  expect(wantsQr({ colour: true, columns: 80, rows: 25 })).toBe(false);  // too short
  expect(wantsQr({ colour: true, columns: 80, rows: 40 })).toBe(true);
});

test("37 columns and 26 rows are the exact thresholds", () => {
  // 29 modules + 4 quiet each side = 37 columns.
  expect(wantsQr({ colour: true, columns: 37, rows: 26 })).toBe(true);
  expect(wantsQr({ colour: true, columns: 36, rows: 26 })).toBe(false);
  expect(wantsQr({ colour: true, columns: 37, rows: 25 })).toBe(false);
});

test("the prose is dropped below 34 rows and kept at or above it", () => {
  // 6 state + 7 prose + 19 QR + 1 blank + 1 trailing = 34.
  expect(wantsCompact(33)).toBe(true);
  expect(wantsCompact(34)).toBe(false);
  expect(wantsCompact(80)).toBe(false);
});
