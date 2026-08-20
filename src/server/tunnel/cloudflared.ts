/**
 * The one place that knows `cloudflared` exists. Nothing here imports anything
 * from paddock, and nothing in paddock imports it except `tunnel/run.ts`.
 */

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

/**
 * Spawn `cloudflared` and resolve once it has told us the URL.
 *
 * The URL is READ, never constructed: the hostname is Cloudflare's to choose
 * and there is no way to derive it. A run that never prints one rejects rather
 * than returning a plausible string, because a wrong URL printed confidently is
 * worse than a failure — the operator would send it to their phone and blame
 * paddock for the 404.
 *
 * BOTH pipes are drained. cloudflared logs to stderr, but draining only the
 * pipe we expect would let the other fill its buffer and stall the child.
 *
 * NOTHING SPAWNED HERE OUTLIVES A FAILED START. Every path that rejects before
 * a `Tunnel` exists kills the child first — the no-URL timeout especially,
 * which used to reject and walk away from a running cloudflared: a public URL
 * alive with no paddock behind it, which is the worst failure this feature has.
 * `onSpawn` closes the other half of that window: the caller cannot register a
 * teardown for a child it has no handle on, and the wait for a URL is seconds
 * long, so the child is handed over the moment it exists rather than when it
 * has said something useful.
 */
export async function startTunnel(opts: {
  port: number;
  bin?: string;
  spawn?: SpawnFn;
  timeoutMs?: number;
  onLog?: (line: string) => void;
  /**
   * Called with the child as soon as it is spawned, BEFORE any URL is read, so
   * the caller can reap it if the process is asked to shut down during startup.
   * The same object this function later wraps in the returned `Tunnel`.
   */
  onSpawn?: (child: Child) => void;
  /** Injected so a test does not wait out a real grace period. */
  killGraceMs?: number;
}): Promise<Tunnel> {
  const bin = opts.bin ?? "cloudflared";
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const graceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const log = opts.onLog ?? ((l: string) => console.info(`[cloudflared] ${l}`));

  const child = spawn([
    bin, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${opts.port}`,
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

  const take = (line: string) => {
    if (line !== "") log(line);
    const u = extractUrl(line);
    if (u !== null && found === null) {
      found = u;
      resolveUrl(u);
    }
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
    throw new Error(`cloudflared exited ${code} before publishing a URL`);
  });
  const timedOut = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`cloudflared printed no url within ${timeoutMs}ms`)),
      timeoutMs,
    ).unref?.();
  });

  // `died` and `timedOut` are also raced here, not just `urlSeen`. Whichever
  // promise loses the race is left pending (a rejection) or simply never
  // observed again (a timer that never fires because the process already
  // returned). Both `died` and `timedOut` are attached to this `Promise.race`,
  // and `Promise.race` itself subscribes a handler to every promise passed to
  // it — so even the loser is never "unhandled" from the runtime's point of
  // view; the race's internal subscription counts as handling. See the
  // Promise-lifetime note in the report for the full argument.
  let url: string;
  try {
    url = await Promise.race([urlSeen, died, timedOut]);
  } catch (e) {
    // The reason this try/catch exists. A timeout leaves a LIVE cloudflared,
    // and rejecting without killing it hands the operator a failure message
    // and a public URL at the same time — the failure they were told about
    // being precisely the one they cannot see.
    if (!hasExited) {
      try {
        await terminate(child, graceMs);
      } catch (killErr) {
        // Reported, never allowed to replace the real error below: the caller
        // needs to know why the start failed, and a kill failure on top of it
        // is a second fact, not a substitute for the first.
        warn(
          `[cloudflared] could not stop the child after a failed start (${String(killErr)}) — ` +
            "check by hand: `pgrep -af 'cloudflared tunnel'`",
        );
      }
    }
    throw e;
  }

  return {
    url,
    exited: child.exited,
    stop: () => terminate(child, graceMs),
  };
}
