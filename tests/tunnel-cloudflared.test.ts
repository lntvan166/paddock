import { expect, test } from "bun:test";
import {
  extractUrl, findCloudflared, installHint, startTunnel, type Child,
} from "@server/tunnel/cloudflared";

const HOST = "https://quiet-harbor-8f31.trycloudflare.com";

/** cloudflared boxes the URL in its log output, on stderr. */
const REAL_ISH = [
  "2026-08-20T09:14:02Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "2026-08-20T09:14:04Z INF +------------------------------------------------------+",
  "2026-08-20T09:14:04Z INF |  Your quick Tunnel has been created! Visit it at:    |",
  `2026-08-20T09:14:04Z INF |  ${HOST}  |`,
  "2026-08-20T09:14:04Z INF +------------------------------------------------------+",
].join("\n");

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  });
}

function child(over: Partial<Child> = {}): Child {
  return {
    stdout: stream(""),
    stderr: stream(REAL_ISH),
    exited: new Promise<number>(() => {}),
    kill() {},
    ...over,
  };
}

test("the URL is extracted from cloudflared's own boxed output", () => {
  expect(extractUrl(REAL_ISH)).toBe(HOST);
});

test("extraction accepts only a trycloudflare host, and never guesses", () => {
  expect(extractUrl("INF no url here")).toBe(null);
  expect(extractUrl("visit https://paddock.example.com/ instead")).toBe(null);
  expect(extractUrl("http://quiet-harbor-8f31.trycloudflare.com")).toBe(null);
  // A lookalike suffix is somebody else's domain wearing ours as a prefix.
  expect(extractUrl("https://a.trycloudflare.com.example.net")).toBe(null);
});

test("the install hint names a command for each platform", () => {
  expect(installHint("darwin")).toContain("brew install cloudflared");
  expect(installHint("linux")).toContain("cloudflared");
  expect(installHint("win32")).toContain("winget");
  // Every hint carries the docs URL, since no one-liner covers every distro.
  for (const p of ["darwin", "linux", "win32", "freebsd"]) {
    expect(installHint(p)).toContain("developers.cloudflare.com");
  }
});

test("findCloudflared reports the path, or null", () => {
  expect(findCloudflared(() => "/somewhere/cloudflared")).toBe("/somewhere/cloudflared");
  expect(findCloudflared(() => null)).toBe(null);
});

test("startTunnel resolves with the URL and passes the port to the child", async () => {
  let cmd: string[] = [];
  const t = await startTunnel({
    port: 8788,
    bin: "/somewhere/cloudflared",
    spawn: (c) => { cmd = c; return child(); },
  });
  expect(t.url).toBe(HOST);
  expect(cmd[0]).toBe("/somewhere/cloudflared");
  expect(cmd).toContain("--url");
  expect(cmd).toContain("http://127.0.0.1:8788");
});

test("a child that prints no URL is a loud failure, not a guess", async () => {
  await expect(startTunnel({
    port: 8788,
    bin: "cf",
    timeoutMs: 20,
    killGraceMs: 5,
    spawn: () => child({ stderr: stream("INF starting\nINF connected\n") }),
  })).rejects.toThrow(/no url/i);
});

test("a child that prints no URL is KILLED, not left holding a public URL", async () => {
  // The timeout used to reject and walk away from a running cloudflared: the
  // operator got a failure message and a live tunnel at the same time, which
  // is the orphaned-child failure with a diagnostic printed over the top of
  // it. Asserting the rejection alone did not catch that — the kill is the
  // half that matters.
  const killed: (number | string | undefined)[] = [];
  let resolveExit: (n: number) => void = () => {};
  await expect(startTunnel({
    port: 8788,
    bin: "cf",
    timeoutMs: 20,
    killGraceMs: 50,
    spawn: () => child({
      stderr: stream("INF starting\nINF connected\n"),
      exited: new Promise<number>((r) => { resolveExit = r; }),
      kill: (sig) => { killed.push(sig); resolveExit(0); },
    }),
  })).rejects.toThrow(/no url/i);
  expect(killed).toEqual(["SIGTERM"]);
});

test("a child that ignores SIGTERM is escalated to SIGKILL, and the start still fails", async () => {
  const killed: (number | string | undefined)[] = [];
  await expect(startTunnel({
    port: 8788,
    bin: "cf",
    timeoutMs: 5,
    killGraceMs: 5,
    spawn: () => child({
      stderr: stream("INF starting\n"),
      // Never exits, whatever it is sent. The kill sequence must be BOUNDED:
      // an unbounded wait here would hang the shutdown path itself.
      exited: new Promise<number>(() => {}),
      kill: (sig) => { killed.push(sig); },
    }),
  })).rejects.toThrow(/no url/i);
  expect(killed).toEqual(["SIGTERM", "SIGKILL"]);
});

test("onSpawn hands over the child before any URL, and it is the one the tunnel wraps", async () => {
  // runTunnel cannot register a teardown for a child it has no handle on, and
  // the wait for a URL is seconds long — so the handover must happen at spawn
  // time, not at resolve time.
  const seen: Child[] = [];
  // A container, not a bare `let`: TypeScript narrows a `let` assigned only
  // inside a callback to `null` at every later read.
  const box: { spawned: Child | null } = { spawned: null };
  let logged = 0;
  let logsAtHandover = -1;
  const t = await startTunnel({
    port: 8788,
    bin: "cf",
    spawn: () => {
      box.spawned = child();
      return box.spawned;
    },
    onLog: () => { logged += 1; },
    onSpawn: (c) => { seen.push(c); logsAtHandover = logged; },
  });
  expect(seen.length).toBe(1);
  // Handed over before a single line had been read off either pipe, let alone
  // the line carrying the URL.
  expect(logsAtHandover).toBe(0);
  expect(logged).toBeGreaterThan(0);
  expect(seen[0]).toBe(box.spawned!);
  // The same object the Tunnel is built around: `stop()` must kill THAT child.
  expect(t.url).toBe(HOST);
});

test("a child that dies before printing a URL is not killed again", async () => {
  // Nothing to reap, and `kill()` on an already-reaped child is exactly the
  // call a prior review could not vouch for. Do not make it.
  const killed: (number | string | undefined)[] = [];
  await expect(startTunnel({
    port: 8788,
    bin: "cf",
    timeoutMs: 500,
    spawn: () => child({
      stderr: stream("ERR failed to connect\n"),
      exited: Promise.resolve(1),
      kill: (sig) => { killed.push(sig); },
    }),
  })).rejects.toThrow(/exited 1/i);
  expect(killed).toEqual([]);
});

test("a child that dies before printing a URL reports its exit status", async () => {
  await expect(startTunnel({
    port: 8788,
    bin: "cf",
    timeoutMs: 500,
    spawn: () => child({ stderr: stream("ERR failed to connect\n"), exited: Promise.resolve(1) }),
  })).rejects.toThrow(/exited 1/i);
});

test("every line is forwarded, so a failure is never silent", async () => {
  const seen: string[] = [];
  await startTunnel({
    port: 8788, bin: "cf",
    spawn: () => child(),
    onLog: (l) => seen.push(l),
  });
  expect(seen.some((l) => l.includes("Requesting new quick Tunnel"))).toBe(true);
});

test("stop kills the child and waits for it", async () => {
  const killed: (number | string | undefined)[] = [];
  let resolveExit: (n: number) => void = () => {};
  const t = await startTunnel({
    port: 8788, bin: "cf",
    spawn: () => child({
      exited: new Promise<number>((r) => { resolveExit = r; }),
      kill: (s) => { killed.push(s); resolveExit(0); },
    }),
  });
  await t.stop();
  expect(killed.length).toBeGreaterThan(0);
  expect(await t.exited).toBe(0);
});
