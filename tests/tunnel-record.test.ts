import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AgentStore } from "@server/state/store";
import type { Tunnel } from "@server/tunnel/cloudflared";
import { Pairing } from "@server/tunnel/pairing";
import { runTunnel, type TunnelDeps } from "@server/tunnel/run";
import { askControl } from "@server/tunnel/control";
import { checkTunnelState, controlSocket } from "@server/tunnel/state";
import { Hub } from "@server/ws/hub";

const PUBLIC_URL = "https://quiet-harbor-8f31.trycloudflare.com";

function base(): Omit<TunnelDeps, "port"> {
  const app = new Hono();
  app.get("/", (c) => c.html("<h1>dashboard</h1>"));
  return {
    app, hub: new Hub({ now: () => 0 }), hostId: "dev-box",
    store: new AgentStore("dev-box"), pairing: new Pairing({ now: () => 0 }),
    env: {}, isTty: false,
  };
}

const fake: TunnelDeps["startTunnel"] = async () => {
  const t: Tunnel = {
    url: PUBLIC_URL,
    exited: new Promise<number>(() => {}),
    stop: async () => {},
  };
  return t;
};

function capture() {
  const said: string[] = [];
  const realInfo = console.info, realError = console.error, realWarn = console.warn;
  console.info = (...a: unknown[]) => { said.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { said.push(a.join(" ")); };
  console.warn = (...a: unknown[]) => { said.push(a.join(" ")); };
  return {
    text: () => said.join("\n"),
    restore: () => { console.info = realInfo; console.error = realError; console.warn = realWarn; },
  };
}

test("a recording run is findable, answers its code, and cleans up after itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-record-"));
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
  const d = base();
  const c = capture();
  try {
    const run = runTunnel({
      ...d,
      port: 0,
      startTunnel: fake,
      record: { dir },
      registerShutdown: (fn) => { reg.teardown = fn; },
    });
    await Bun.sleep(30);

    // Findable: the record names this process and the URL that was published.
    const got = await checkTunnelState(dir);
    expect(got.kind).toBe("running");
    if (got.kind !== "running") throw new Error("unreachable");
    expect(got.state.pid).toBe(process.pid);
    expect(got.state.url).toBe(PUBLIC_URL);
    expect(got.state.control).toBe(controlSocket(dir));
    expect(got.state.publishing).toBeNull();

    // The record carries NO code — that is the point of the socket. A code in
    // the file would be a snapshot nothing can refresh.
    expect(JSON.stringify(got.state)).not.toContain(d.pairing.current().code);

    // And the socket answers with the live one.
    const ask = await askControl(got.state.control);
    expect(ask.ok).toBe(true);
    if (!ask.ok) throw new Error("unreachable");
    expect(ask.answer.code).toBe(d.pairing.current().code);
    expect(ask.answer.url).toBe(PUBLIC_URL);

    // Teardown takes both with it. A record left behind would tell `pair` a
    // tunnel is up. (The socket path is removed by `removeTunnelState` as well
    // as by `control.stop()`, so this asserts the END STATE and not which of
    // the two did it — `stop()` is covered where it is observable, in
    // tunnel-control.test.ts.)
    await reg.teardown!();
    expect((await checkTunnelState(dir)).kind).toBe("none");
    expect(await Bun.file(controlSocket(dir)).exists()).toBe(false);
    void run;
  } finally { c.restore(); }
});

test("a run given no dir records nothing and leaves no socket", async () => {
  // The default, and every pre-existing test's path: publishing must not
  // depend on being trackable.
  const dir = await mkdtemp(join(tmpdir(), "paddock-record-none-"));
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
  const c = capture();
  try {
    const run = runTunnel({
      ...base(), port: 0, startTunnel: fake,
      registerShutdown: (fn) => { reg.teardown = fn; },
    });
    await Bun.sleep(30);
    expect((await checkTunnelState(dir)).kind).toBe("none");
    expect(await Bun.file(controlSocket(dir)).exists()).toBe(false);
    await reg.teardown!();
    void run;
  } finally { c.restore(); }
});

test("a socket left behind by a dead run does not stop the next one binding", async () => {
  // The crash path. A unix socket is a file: a run that died without teardown
  // leaves the path in place, and a bind against an existing path fails. That
  // failure would land on a tunnel that is already live and carrying traffic.
  const dir = await mkdtemp(join(tmpdir(), "paddock-record-stale-"));
  await Bun.write(controlSocket(dir), "not a socket");
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
  const d = base();
  const c = capture();
  try {
    const run = runTunnel({
      ...d, port: 0, startTunnel: fake, record: { dir },
      registerShutdown: (fn) => { reg.teardown = fn; },
    });
    await Bun.sleep(30);
    const ask = await askControl(controlSocket(dir));
    expect(ask.ok, `control socket should answer: ${JSON.stringify(ask)}`).toBe(true);
    await reg.teardown!();
    void run;
  } finally { c.restore(); }
});

test("the upstream port is recorded when publishing a running paddock", async () => {
  // So `status` can say WHICH paddock a tunnel publishes, and so the 2x2 of
  // --detach x --publish-running is legible after the fact.
  const dir = await mkdtemp(join(tmpdir(), "paddock-record-pub-"));
  const reg: { teardown: (() => Promise<boolean>) | null } = { teardown: null };
  const c = capture();
  try {
    const run = runTunnel({
      ...base(), port: 0, startTunnel: fake,
      record: { dir, publishing: 8787 },
      registerShutdown: (fn) => { reg.teardown = fn; },
    });
    await Bun.sleep(30);
    const got = await checkTunnelState(dir);
    if (got.kind !== "running") throw new Error(`expected running, got ${got.kind}`);
    expect(got.state.publishing).toBe(8787);
    await reg.teardown!();
    void run;
  } finally { c.restore(); }
});
