/**
 * The one place that knows `cloudflared` exists. Nothing here imports anything
 * from paddock, and nothing in paddock imports it except `tunnel/run.ts`.
 */

import { Resolver } from "node:dns/promises";
import { QUICK_TUNNEL_RE } from "@shared/quick-tunnel";
import { warn } from "@server/term";

/**
 * The regex is imported, not restated. It is anchored on BOTH ends so that
 * `a.trycloudflare.com.example.net` — somebody else's domain wearing the suffix
 * as a prefix — does not match, and a second copy of that reasoning here would
 * be a second chance to get it wrong.
 */
export function extractUrl(chunk: string): string | null {
  return chunk.match(QUICK_TUNNEL_RE)?.[0] ?? null;
}

/**
 * cloudflared's line for a live edge connection. It prints the URL BEFORE
 * this: the hostname is assigned first, and until a connection registers,
 * Cloudflare answers the URL with error 1033.
 */
export const REGISTERED_RE = /Registered tunnel connection/i;

/**
 * Whether a quick tunnel's hostname resolves yet, asked of Cloudflare's own
 * public resolvers rather than the system's: a lookup made too early comes
 * back NXDOMAIN, and asking the system resolver would put that answer in the
 * machine's (and the network's) negative cache, the very thing the wait is
 * there to keep off the person's phone.
 */
export async function resolvesPublicly(host: string): Promise<boolean> {
  const r = new Resolver({ timeout: 3000, tries: 1 });
  r.setServers(["1.1.1.1", "1.0.0.1"]);
  try { return (await r.resolve4(host)).length > 0; }
  catch { return false; } // NXDOMAIN, or no answer yet: "not yet", polled again
}

export function installHint(platform: string): string {
  const docs =
    "  other platforms: https://developers.cloudflare.com/cloudflare-one/\n" +
    "                   connections/connect-networks/downloads/";
  const one =
    platform === "darwin"
      ? "    brew install cloudflared"
      : platform === "win32"
        ? "    winget install --id Cloudflare.cloudflared"
        : platform === "linux"
          ? "    install the cloudflared package for your distro, or the binary"
          : "    download the cloudflared binary for your platform";
  return `${one}\n\n${docs}`;
}

export function findCloudflared(
  which: (bin: string) => string | null = (b) => Bun.which(b),
): string | null {
  return which("cloudflared");
}

export interface Child {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(sig?: number | string): void;
}

export type SpawnFn = (cmd: string[]) => Child;

/** How long a child gets to honour a signal before the next one. */
export const KILL_GRACE_MS = 3000;

async function exitedWithin(child: Child, ms: number): Promise<boolean> {
  const late = Symbol("late");
  const timer = new Promise<typeof late>((r) => {
    setTimeout(() => r(late), ms).unref?.();
  });
  return (await Promise.race([child.exited, timer])) !== late;
}

/**
 * SIGTERM, grace, SIGKILL, grace. The ONE kill sequence in this codebase.
 *
 * Extracted because there are now three callers — `Tunnel.stop()`, the
 * pre-resolve failure path in `startTunnel`, and `runTunnel`'s teardown for a
 * child that was spawned but never published a URL. A second transcription of
 * this sequence is a second chance to get the escalation wrong, and the thing
 * being escalated is a process holding a PUBLIC URL open.
 *
 * It is BOUNDED, and throws rather than waiting for ever. An unbounded
 * `await child.exited` after the kill would hang the shutdown path itself,
 * which for `paddock tunnel` means Ctrl-C never returning and the state file
 * never being cleared — a worse failure than the one it was waiting to
 * confirm. A child still alive after SIGKILL is something only the operator
 * can act on, so it is reported as an error and never as a clean stop.
 */
export async function terminate(child: Child, graceMs: number = KILL_GRACE_MS): Promise<void> {
  child.kill("SIGTERM");
  if (await exitedWithin(child, graceMs)) return;
  child.kill("SIGKILL");
  if (await exitedWithin(child, graceMs)) return;
  throw new Error(`cloudflared did not exit within ${graceMs}ms of SIGKILL`);
}

export interface Tunnel {
  url: string;
  exited: Promise<number>;
  stop(): Promise<void>;
}

const defaultSpawn: SpawnFn = (cmd) =>
  Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }) as unknown as Child;

/** Why an attempt ended before its tunnel connected; "connect" is the one a protocol change can fix. */
class AttemptFailed extends Error {
  constructor(message: string, readonly stage: "url" | "connect") { super(message); }
}

export interface StartOpts {
  port: number;
  bin?: string;
  spawn?: SpawnFn;
  timeoutMs?: number;
  onLog?: (line: string) => void;
  /**
   * Called with the child as soon as it is spawned, BEFORE any URL is read, so
   * the caller can reap it if the process is asked to shut down during startup.
   * Called again for the http2 retry's child: the caller always holds the live one.
   */
  onSpawn?: (child: Child) => void;
  /** Injected so a test does not wait out a real grace period. */
  killGraceMs?: number;
  /** Does the hostname resolve yet? Injected so a test does not touch DNS. */
  resolves?: (host: string) => Promise<boolean>;
  /** How long to wait for the hostname to resolve, after the connection registers. */
  dnsWaitMs?: number;
  dnsPollMs?: number;
  /**
   * How long the first (QUIC) attempt gets to connect after printing its URL
   * before paddock retries over http2.
   */
  quicWaitMs?: number;
}

interface Attempt { url: string; child: Child; exited: () => boolean }

/**
 * One cloudflared, up to a connected tunnel. NOTHING SPAWNED HERE OUTLIVES A
 * FAILED ATTEMPT: every rejection kills the child first.
 */
async function attempt(opts: StartOpts, protocol: "http2" | null, connectMs: number): Promise<Attempt> {
  const bin = opts.bin ?? "cloudflared";
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const graceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const log = opts.onLog ?? ((l: string) => console.info(`[cloudflared] ${l}`));

  const child = spawn([
    bin, "tunnel", "--no-autoupdate",
    ...(protocol ? ["--protocol", protocol] : []),
    "--url", `http://127.0.0.1:${opts.port}`,
  ]);
  // Before the first await, so a caller that registers a teardown and only
  // then awaits this promise is already holding the child by the time it does.
  opts.onSpawn?.(child);

  // Whether a kill is still owed. Not a swallowed error: `child.exited` is the
  // only thing that can answer this, and the rejection branch reports.
  let hasExited = false;
  void child.exited.then(
    () => { hasExited = true; },
    (e) => {
      hasExited = true;
      console.error(`[cloudflared] could not wait on the child: ${String(e)}`);
    },
  );

  let found: string | null = null;
  let resolveUrl: (u: string) => void = () => {};
  const urlSeen = new Promise<string>((r) => { resolveUrl = r; });
  let resolveRegistered: () => void = () => {};
  const registered = new Promise<void>((r) => { resolveRegistered = r; });

  const take = (line: string) => {
    if (line !== "") log(line);
    const u = extractUrl(line);
    if (u !== null && found === null) {
      found = u;
      resolveUrl(u);
    }
    if (REGISTERED_RE.test(line)) resolveRegistered();
  };

  const drain = async (s: ReadableStream<Uint8Array> | null) => {
    if (s === null) return;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const bytes of s as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(bytes, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) take(line);
    }
    if (buf !== "") take(buf);
  };

  // Not awaited: these run for the life of the child. The rejection is
  // reported rather than dropped — Bun ends the process on an unhandled one.
  void Promise.all([drain(child.stdout), drain(child.stderr)]).catch((e) =>
    console.error(`[cloudflared] could not read output: ${String(e)}`),
  );

  const died = child.exited.then<never>((code) => {
    throw found === null
      ? new AttemptFailed(`cloudflared exited ${code} before publishing a URL`, "url")
      : new AttemptFailed(`cloudflared exited ${code} before connecting ${found}`, "connect");
  });
  const deadline = (ms: number, why: () => AttemptFailed) => new Promise<never>((_, reject) => {
    setTimeout(() => reject(why()), ms).unref?.();
  });

  // `died` and the deadlines are raced with every wait. `Promise.race`
  // subscribes a handler to every promise passed to it, so the losers are never
  // "unhandled" from the runtime's point of view.
  //
  // The URL is NOT the moment the tunnel works. cloudflared prints it before
  // any edge connection exists and before the hostname resolves, and a link
  // handed out then is a phone that gets error 1033, or an NXDOMAIN its
  // resolver then caches: a person scanning the QR the moment it appears saw
  // no dashboard at all, and nothing said why. So an attempt ends only once a
  // connection has registered.
  let url: string;
  try {
    url = await Promise.race([urlSeen, died,
      deadline(timeoutMs, () => new AttemptFailed(`cloudflared printed no url within ${timeoutMs}ms`, "url"))]);
    await Promise.race([registered, died,
      deadline(connectMs, () => new AttemptFailed(
        `cloudflared printed ${found} but did not connect it to Cloudflare within ${connectMs}ms`, "connect"))]);
  } catch (e) {
    // A timeout leaves a LIVE cloudflared, and rejecting without killing it
    // hands the operator a failure message and a public URL at the same time.
    if (!hasExited) {
      try {
        await terminate(child, graceMs);
      } catch (killErr) {
        // Reported, never allowed to replace the real error: a kill failure on
        // top of it is a second fact, not a substitute for the first.
        warn(
          `[cloudflared] could not stop the child after a failed start (${String(killErr)}) — ` +
            "check by hand: `pgrep -af 'cloudflared tunnel'`",
        );
      }
    }
    throw e;
  }
  return { url, child, exited: () => hasExited };
}

/**
 * Spawn `cloudflared` and resolve once its tunnel is connected and its URL
 * resolves.
 *
 * The URL is READ, never constructed: the hostname is Cloudflare's to choose
 * and there is no way to derive it. A run that never prints one rejects rather
 * than returning a plausible string.
 *
 * BOTH pipes are drained. cloudflared logs to stderr, but draining only the
 * pipe we expect would let the other fill its buffer and stall the child.
 *
 * QUIC FIRST, THEN HTTP2. cloudflared reaches Cloudflare's edge over QUIC
 * (UDP 7844) by default, and plenty of networks drop that: cloudflared still
 * prints a URL (asking for one is plain HTTPS) and then retries the edge for
 * ever, so the link never opens however long you wait. A first attempt that
 * prints a URL and does not connect within `quicWaitMs` is killed and the
 * start is retried with `--protocol http2`, over TCP 443. The retry gets a NEW
 * URL; the first one is never handed out.
 */
export async function startTunnel(opts: StartOpts): Promise<Tunnel> {
  const graceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let a: Attempt;
  try {
    a = await attempt(opts, null, Math.min(opts.quicWaitMs ?? 15_000, timeoutMs));
  } catch (e) {
    if (!(e instanceof AttemptFailed) || e.stage !== "connect") throw e;
    warn(`[cloudflared] ${e.message}; the network may block QUIC (UDP 7844), retrying over http2`);
    try {
      a = await attempt(opts, "http2", timeoutMs);
    } catch (e2) {
      throw new Error(`${(e2 as Error).message} (over http2, after QUIC did not connect either)`);
    }
  }
  const { url, child } = a;

  // Bounded, and not fatal: the tunnel is up, and a slow resolver somewhere
  // should not cost the person a working link. It is said, never hidden.
  // PADDOCK_TUNNEL_DNS_WAIT_MS=0 skips the lookup: the process tests run a
  // stub cloudflared whose made-up hostname no resolver will ever know.
  const resolves = opts.resolves ?? resolvesPublicly;
  const host = new URL(url).hostname;
  const envWait = Number(process.env.PADDOCK_TUNNEL_DNS_WAIT_MS);
  const dnsWaitMs = opts.dnsWaitMs ?? (Number.isFinite(envWait) && process.env.PADDOCK_TUNNEL_DNS_WAIT_MS !== "" ? envWait : 20_000);
  const dnsUntil = Date.now() + dnsWaitMs;
  const poll = opts.dnsPollMs ?? 1000;
  let resolved = dnsWaitMs <= 0 || await resolves(host);
  while (!resolved && !a.exited() && Date.now() < dnsUntil) {
    await new Promise((r) => setTimeout(r, poll));
    resolved = await resolves(host);
  }
  if (a.exited()) {
    throw new Error(`cloudflared exited while ${host} was still resolving`);
  }
  if (!resolved) {
    warn(`[cloudflared] ${host} is connected but does not resolve yet; it can take a minute to open`);
  }

  return {
    url,
    exited: child.exited,
    stop: () => terminate(child, graceMs),
  };
}
