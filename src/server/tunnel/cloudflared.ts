/**
 * The one place that knows `cloudflared` exists. Nothing here imports anything
 * from paddock, and nothing in paddock imports it except `tunnel/run.ts`.
 */

import { QUICK_TUNNEL_RE } from "@shared/quick-tunnel";

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
 */
export async function startTunnel(opts: {
  port: number;
  bin?: string;
  spawn?: SpawnFn;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}): Promise<Tunnel> {
  const bin = opts.bin ?? "cloudflared";
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const log = opts.onLog ?? ((l: string) => console.info(`[cloudflared] ${l}`));

  const child = spawn([
    bin, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${opts.port}`,
  ]);

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
  const url = await Promise.race([urlSeen, died, timedOut]);

  return {
    url,
    exited: child.exited,
    async stop() {
      child.kill("SIGTERM");
      const grace = new Promise<"grace">((r) => {
        setTimeout(() => r("grace"), 3000).unref?.();
      });
      if ((await Promise.race([child.exited, grace])) === "grace") child.kill("SIGKILL");
      await child.exited;
    },
  };
}
