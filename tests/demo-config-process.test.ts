import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `paddock --demo`, STARTED AS A PROCESS, against a config dir holding an
 * operator's real-looking settings.
 *
 * The demo used to load `PADDOCK_CONFIG_DIR` like a real run: its Settings
 * screen showed the operator's Telegram chat id, their own domain and how many
 * phones get pushes, and README screenshots come from `--demo`. It also wrote
 * there. The fix lives in `index.ts`'s top level, which only a process
 * exercises, so that is what this does.
 */

const REAL_SETTINGS = {
  telegram: { token: "123456:invented-token-wxyz", chatId: "424242" },
  publicUrl: "https://paddock.example.com",
};

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

test("--demo reads nothing from, and writes nothing to, the operator's config dir", async () => {
  const cfg = await mkdtemp(join(tmpdir(), "paddock-demo-real-"));
  const settingsPath = join(cfg, "settings.json");
  await writeFile(settingsPath, JSON.stringify(REAL_SETTINGS));
  const before = await readFile(settingsPath, "utf8");
  const port = await freePort();

  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "src", "server", "index.ts"), "--demo"],
    {
      env: {
        ...process.env,
        PADDOCK_CONFIG_DIR: cfg,
        PADDOCK_PORT: String(port),
        PADDOCK_NO_UPDATE_CHECK: "1",
        // Would seed a real bot into the demo's settings if the env reached them.
        PADDOCK_TELEGRAM_TOKEN: "999999:env-token-abcd",
        PADDOCK_TELEGRAM_CHAT_ID: "777",
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let err = "";
  void (async () => {
    for await (const b of child.stderr as unknown as AsyncIterable<Uint8Array>) err += new TextDecoder().decode(b);
  })();

  try {
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${base}/api/health`)).ok; } catch { await Bun.sleep(50); }
    }
    expect(up, `the demo never answered: ${err}`).toBe(true);

    const view = await (await fetch(`${base}/api/settings`)).json() as Record<string, any>;
    expect(view.telegram.configured).toBe(false);
    expect(view.telegram.chatId ?? null).toBeNull();
    expect(view.publicUrl ?? null).toBeNull();
    expect(view.push.devices).toBe(0);

    // A settings write in the demo lands in the demo's own dir, never the operator's.
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ bridge: { enabled: true } }),
    });
    expect(res.status).toBeLessThan(500);
    expect(await readFile(settingsPath, "utf8")).toBe(before);
    // Nor push keys, uploads or a cache: only the state record, which says a
    // paddock runs on this port (so `status` and `stop` see a demo too).
    expect((await readdir(cfg)).filter((f) => f !== "paddock.state.json").sort()).toEqual(["settings.json"]);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }

  // Its own dir is gone with it.
  const dirLine = /paddock-demo-[A-Za-z0-9]+/.exec(err);
  if (dirLine) expect(existsSync(join(tmpdir(), dirLine[0]))).toBe(false);
}, 30_000);
