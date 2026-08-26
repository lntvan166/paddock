import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTunnelState } from "@server/tunnel/state";

/**
 * `paddock tunnel --publish-running`, STARTED AS A PROCESS.
 *
 * This file exists because of a bug the rest of the suite could not see. The
 * `--publish-running` block sits at the top of `index.ts` and assigned a
 * `let onShutdown` declared several hundred lines below it — a temporal dead
 * zone read, so every run of the command died with
 * `ReferenceError: Cannot access 'onShutdown' before initialization`.
 *
 * Nothing caught it. `tsc` does not flag a TDZ read; the unit tests call
 * `runTunnel` directly and never execute `index.ts`'s top level. A top-level
 * script's wiring is only testable by running it, so that is what this does.
 *
 * It uses a stub `cloudflared` and a stub upstream: no edge connection, nothing
 * published anywhere, and the operator's own ports untouched.
 */
async function stubs() {
  const root = await mkdtemp(join(tmpdir(), "paddock-pubrun-proc-"));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  // Prints the one line the URL parser looks for, records its own pid so the
  // test can check it was killed, then idles. It does NOT trap anything: the
  // question is whether paddock signals it at all.
  const pidFile = join(root, "cloudflared.pid");
  await writeFile(
    join(bin, "cloudflared"),
    "#!/bin/sh\n" +
      `echo $$ > ${pidFile}\n` +
      'echo "INF |  https://stub-pubrun.trycloudflare.com  |" >&2\n' +
      "while :; do sleep 0.2; done\n",
  );
  await chmod(join(bin, "cloudflared"), 0o755);
  return { root, bin, cfg: join(root, "cfg"), pidFile };
}

test("the command starts, publishes, and tears down on SIGTERM", async () => {
  const { root, bin, cfg, pidFile } = await stubs();

  // The paddock being published. Only `/api/health` matters: `upstreamAlive`
  // is what decides whether there is anything to publish.
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/api/health"
        ? new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          })
        : new Response("upstream", { status: 200 }),
  });

  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "src", "server", "index.ts"),
     "tunnel", "--publish-running"],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PADDOCK_CONFIG_DIR: cfg,
        PADDOCK_PORT: String(upstream.port),
        PADDOCK_TUNNEL_PORT: "0",
        // No colour and no tty: the display must not emit clear-screen writes
        // that would erase this runner's own output.
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Accumulated as it arrives, and NOT awaited to completion: the child is
  // meant to keep running, so `new Response(child.stderr).text()` would block
  // until it exited — which is a test that times out rather than fails.
  let err = "";
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      err += dec.decode(chunk, { stream: true });
    }
  })();

  try {
    // Wait for it to record itself, which is proof it got past every line of
    // top-level wiring and actually published.
    let recorded = false;
    for (let i = 0; i < 100 && !recorded; i++) {
      recorded = (await checkTunnelState(cfg)).kind === "running";
      if (!recorded) await Bun.sleep(100);
    }

    // Named explicitly: this is the regression, and a generic "it started"
    // assertion would not say what broke.
    expect(err).not.toContain("ReferenceError");
    expect(err).not.toContain("before initialization");
    expect(recorded, `never recorded itself. stderr:\n${err}`).toBe(true);

    const got = await checkTunnelState(cfg);
    if (got.kind !== "running") throw new Error("unreachable");
    // It PUBLISHES rather than serves — the whole point of the flag.
    expect(got.state.publishing).toBe(upstream.port as number);
    expect(got.state.url).toBe("https://stub-pubrun.trycloudflare.com");

    // And it honours a signal. Without a handler of its own this process would
    // die leaving cloudflared alive — a public URL still resolving with nothing
    // behind it, which this codebase calls its worst failure.
    // The cloudflared pid, captured BEFORE the signal — after the parent is
    // gone there is nothing left to ask.
    const cfPid = Number((await Bun.file(pidFile).text()).trim());
    expect(Number.isInteger(cfPid) && cfPid > 0).toBe(true);

    child.kill("SIGTERM");
    await child.exited;
    expect((await checkTunnelState(cfg)).kind).toBe("none");

    /**
     * THE ORPHAN CHECK, and the reason this test is worth its cost.
     *
     * cloudflared is a CHILD of the process just stopped, and nothing signalled
     * it directly — so if paddock's teardown did not kill it, it is still
     * running with a public URL still resolving and nothing behind it. This
     * codebase calls that its worst failure, and it is invisible from a
     * terminal that has returned to a prompt.
     *
     * Asserted separately from the record's removal, because the two can
     * disagree: the shutdown handler removes the record itself as a backstop,
     * so a tidy config dir is NOT evidence the child was reaped.
     */
    let cfAlive = true;
    for (let i = 0; i < 50 && cfAlive; i++) {
      try { process.kill(cfPid, 0); await Bun.sleep(100); }
      catch { cfAlive = false; }
    }
    expect(cfAlive, `cloudflared (pid ${cfPid}) outlived paddock`).toBe(false);
  } finally {
    child.kill("SIGKILL");
    upstream.stop(true);
    await Bun.$`rm -rf ${root}`.quiet().nothrow();
  }
}, 30_000);
