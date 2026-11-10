import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mayRunWithoutHerdr, type StartOutcome } from "@server/herdr/await-start";
import { ProtocolMismatchError } from "@server/herdr/socket";
import { CoreSupervisor, type CoreClientLike } from "@server/herdr-core/supervisor";
import { AgentStore } from "@server/state/store";
import { freePort } from "./support/port";
import { HERDR_PROTOCOL } from "@shared/herdr-api";

/**
 * paddock with the Herdr app and no terminal herdr.
 *
 * The spec's goal "either backend may be absent" was half true: herdr-core
 * could be missing, but a terminal herdr that never appeared still ended the
 * process at boot — so a paddock on a machine that runs only the app could not
 * start at all. Now an ABSENT herdr (the bounded wait gave up: no socket, or a
 * socket nobody serves) with a live core runs on the core alone. Every other
 * herdr failure, and herdr absent with no core either, keeps today's
 * explanation and exit.
 */

const CONFIG = mkdtempSync(join(tmpdir(), "paddock-app-only-"));
afterAll(() => { rmSync(CONFIG, { recursive: true, force: true }); });

const gaveUp = (err: unknown = new Error("connect ENOENT")): StartOutcome =>
  ({ kind: "gaveUp", err, pathKind: "missing", waitedMs: 0, attempts: 1 });

// ── the decision ────────────────────────────────────────────────────────────

test("an absent herdr with a live core runs on the core alone", () => {
  expect(mayRunWithoutHerdr(gaveUp(), true)).toBe(true);
  expect(mayRunWithoutHerdr({ ...gaveUp(), pathKind: "socket" } as StartOutcome, true)).toBe(true);
});

test("an absent herdr with no core is the same failure it always was", () => {
  expect(mayRunWithoutHerdr(gaveUp(), false)).toBe(false);
});

test("a herdr that is there but wrong is never papered over by the core", () => {
  // A mismatch, a path that is not a socket, unreadable permissions, an error
  // paddock cannot diagnose: each is something the operator must be told
  // about now, and running quietly on the app would hide it.
  const fatal = (err: unknown, pathKind: "not-a-socket" | "unreadable" | "socket") =>
    ({ kind: "fatal", err, pathKind }) as StartOutcome;
  expect(mayRunWithoutHerdr(fatal(new ProtocolMismatchError(1, 2), "socket"), true)).toBe(false);
  expect(mayRunWithoutHerdr(fatal(new Error("x"), "not-a-socket"), true)).toBe(false);
  expect(mayRunWithoutHerdr(fatal(new Error("x"), "unreadable"), true)).toBe(false);
  expect(mayRunWithoutHerdr({ kind: "ready", protocol: 20 }, true)).toBe(false);
});

// ── the core's first attempt, which boot waits on ───────────────────────────

test("firstAttempt settles when the core is not there", async () => {
  const sup = new CoreSupervisor({ connect: () => null, store: new AgentStore("dev-box"), onDelta: () => {}, retryMs: 60_000 });
  sup.start();
  await sup.firstAttempt();
  expect(sup.connection()).toBeNull();
  sup.stop();
});

test("firstAttempt settles connected once the snapshot lands", async () => {
  let snap!: (s: unknown) => void;
  const client: CoreClientLike = {
    hello: async () => ({ generation: 1 }) as never,
    request: async () => ({ version: "0.0.1" }) as never,
    subscribe: async (a: never) => { snap = a; setTimeout(() => snap({ channel: null, seq: 1, terminals: [] }), 5); return () => {}; },
    close: () => {},
  } as never;
  const sup = new CoreSupervisor({ connect: () => client, store: new AgentStore("dev-box"), onDelta: () => {} });
  sup.start();
  await sup.firstAttempt();
  expect(sup.connection()).not.toBeNull();
  sup.stop();
});

// ── the real entry point ────────────────────────────────────────────────────

/** A herdr-core that answers hello, server.status and events.subscribe. */
function fakeCore() {
  const path = join(CONFIG, `core-${Math.random().toString(36).slice(2)}.sock`);
  const reporting = {
    address: "t1", argv: ["claude"], cols: 120, rows: 40, created_ms: 1_700_000_000_000,
    cwd: "/path/to/docs-site", name: "release-notes", screen: "exact", state: "live", reported: true,
    labels: { "herdr.space": "docs-site", "herdr.tab": "build", where: "docs-site / 1" },
    status: { app: "claude-code", state: "blocked", kind: "permission", title: "Build" },
    status_ms: 1_700_000_005_000, title: "claude", turn: 2,
  };
  const conns = new Set<{ end(): void }>();
  const server = Bun.listen({
    unix: path,
    socket: {
      open(s) { conns.add(s); },
      close(s) { conns.delete(s); },
      data(s, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          const reply = (result: unknown) => s.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
          if (req.method === "hello") reply({ generation: 1, methods: [], features: [], framed: false, core: { id: "c", name: "dev-box" } });
          else if (req.method === "server.status") reply({ version: "0.0.1-test", pid: 1, core: { id: "c", name: "dev-box" } });
          else if (req.method === "events.subscribe") reply({ channel: null, seq: 1, terminals: [reporting] });
          else if (req.method === "terminal.list") reply({ terminals: [reporting] });
          else s.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "no such method" } }) + "\n");
        }
      },
    },
  });
  return { path, stop: () => { for (const c of conns) c.end(); server.stop(true); } };
}

const baseEnv = (port: number, coreSock: string) => ({
  ...process.env,
  PADDOCK_NO_UPDATE_CHECK: "1",
  PADDOCK_NO_SERVICE: "1",
  PADDOCK_CONFIG_DIR: CONFIG,
  PADDOCK_HERDR_SOCKET: join(CONFIG, "no-such-herdr.sock"),
  PADDOCK_HERDR_WAIT_MS: "0",
  PADDOCK_HC_SOCKET: coreSock,
  PADDOCK_PORT: String(port),
});

async function poll<T>(f: () => Promise<T | null>, ms: number): Promise<T | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await f().catch(() => null);
    if (v !== null) return v;
    await Bun.sleep(100);
  }
  return null;
}

test("herdr absent, core present: paddock serves, and the app's agents are there", async () => {
  const core = fakeCore();
  const port = freePort();
  const proc = Bun.spawn(["bun", "src/server/index.ts"], {
    env: baseEnv(port, core.path), stdout: "pipe", stderr: "pipe",
  });
  try {
    const agents = await poll(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
      if (!res.ok) return null;
      const body = (await res.json()) as { agents: { agentId: string; origin: string }[] };
      return body.agents.length > 0 ? body.agents : null;
    }, 15_000);
    expect(proc.exitCode, "paddock exited instead of running on the app").toBeNull();
    expect(agents?.map((a) => [a.agentId, a.origin])).toEqual([["hc.t1", "core"]]);

    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
      herdrConnected: boolean; core: { connected: boolean };
    };
    expect(health.herdrConnected).toBe(false);
    expect(health.core.connected).toBe(true);

    // The Spaces read survives terminal herdr's absence too.
    const spaces = (await (await fetch(`http://127.0.0.1:${port}/api/spaces`)).json()) as {
      spaces: { spaceId: string }[];
    };
    expect(spaces.spaces.map((s) => s.spaceId)).toEqual(["hc.docs-site"]);
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
    core.stop();
  }
  const said = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  expect(said, "say plainly that it runs on the app alone").toContain("herdr-core only");
}, 30_000);

test("herdr absent, core absent: the same explanation and exit as before", () => {
  const r = Bun.spawnSync(["bun", "src/server/index.ts"], {
    env: baseEnv(freePort(), join(CONFIG, "no-such-core.sock")),
    stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL",
  });
  const said = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  expect(r.exitedDueToTimeout, "paddock kept running with neither backend").toBeFalsy();
  expect(r.exitCode).not.toBe(0);
  expect(said).toContain(join(CONFIG, "no-such-herdr.sock"));
  expect(said).toContain("--demo");
  expect(said).not.toContain("herdr-core only");
}, 30_000);

// ── a terminal herdr that appears LATER, with a broken agent.list ───────────

/**
 * A terminal herdr whose agent.list has lost `workspace_id` on every row — a
 * broken contract that `toAgent` still maps, so without the refusal its agent
 * WOULD be rendered. One response per connection, like herdr; the stream
 * stays open.
 */
function brokenHerdr(path: string) {
  const conns = new Set<{ end(): void }>();
  const server = Bun.listen({
    unix: path,
    socket: {
      open(s) { conns.add(s); },
      close(s) { conns.delete(s); },
      data(s, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          const answer = (result: unknown) => { s.write(JSON.stringify({ id: req.id, result }) + "\n"); s.end(); };
          if (req.method === "ping") answer({ type: "pong", version: "0.0.0-test", protocol: HERDR_PROTOCOL });
          else if (req.method === "workspace.list") answer({ type: "workspace_list", workspaces: [] });
          else if (req.method === "agent.list") {
            answer({ type: "agent_list", agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle", name: "flaky-test-fix" }] });
          } else if (req.method === "events.subscribe") {
            s.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
          } else answer({});
        }
      },
    },
  });
  return { stop: () => { for (const c of conns) c.end(); server.stop(true); } };
}

test("after an app-only boot, a herdr that appears with a broken agent.list is refused, not rendered", async () => {
  const core = fakeCore();
  const port = freePort();
  const herdrSock = join(CONFIG, `late-herdr-${Math.random().toString(36).slice(2)}.sock`);
  const proc = Bun.spawn(["bun", "src/server/index.ts"], {
    env: { ...baseEnv(port, core.path), PADDOCK_HERDR_SOCKET: herdrSock }, stdout: "pipe", stderr: "pipe",
  });
  let said = "";
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of s) said += dec.decode(chunk);
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  const agentsNow = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    return ((await res.json()) as { agents: { agentId: string; origin: string }[] }).agents;
  };
  let herdr: { stop(): void } | null = null;
  try {
    const up = await poll(async () => ((await agentsNow()).length > 0 ? true : null), 15_000);
    expect(up, "the app-only boot never served the core's agents").toBe(true);

    herdr = brokenHerdr(herdrSock);
    const refused = await poll(async () => (said.includes("refusing to show terminal herdr") ? true : null), 25_000);
    expect(refused, `no refusal line; paddock said:\n${said}`).toBe(true);
    await Bun.sleep(500);

    expect(proc.exitCode, "paddock exited instead of staying up on the app").toBeNull();
    expect((await agentsNow()).map((a) => [a.agentId, a.origin])).toEqual([["hc.t1", "core"]]);
    expect(said).not.toContain("showing both backends");
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
      agents: number; core: { connected: boolean };
    };
    expect(health.agents).toBe(1);
    expect(health.core.connected).toBe(true);
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
    herdr?.stop();
    core.stop();
  }
}, 60_000);
