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
    spawn: () => child({ stderr: stream("INF starting\nINF connected\n") }),
  })).rejects.toThrow(/no url/i);
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
