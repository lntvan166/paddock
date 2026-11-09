import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPEN_HERDR_TO_RENAME, Unsupported, createAppSocket } from "@server/herdr-core/app-socket";

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

async function fakeApp(reply: (req: any) => object) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-app-"));
  const path = join(dir, "herdr-app.sock");
  const seen: any[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(s, chunk) {
        const req = JSON.parse(chunk.toString().trim());
        seen.push(req);
        s.write(JSON.stringify(reply(req)) + "\n");
        s.end();
      },
    },
  });
  stop = () => server.stop(true);
  return { path, seen };
}

test("rename sends space.rename with the raw id", async () => {
  const app = await fakeApp(() => ({ ok: true }));
  const sock = createAppSocket(app.path);
  await sock.renameSpace("hc.s1", "api-refactor");
  await sock.renameSpace("s2", "docs-cleanup");
  await sock.renameTab("hc.t3", "flaky-test-fix");
  expect(app.seen).toEqual([
    { do: "space.rename", args: { id: "s1", name: "api-refactor" } },
    { do: "space.rename", args: { id: "s2", name: "docs-cleanup" } },
    { do: "tab.rename", args: { id: "t3", name: "flaky-test-fix" } },
  ]);
});

test("an error reply throws its text", async () => {
  const app = await fakeApp(() => ({ error: 'no space "s9"' }));
  await expect(createAppSocket(app.path).renameSpace("s9", "x")).rejects.toThrow('no space "s9"');
});

test("rename refuses with OPEN_HERDR_TO_RENAME when the app socket is absent", async () => {
  const sock = createAppSocket(join(tmpdir(), "paddock-no-such-app.sock"));
  expect(await sock.available()).toBe(false);
  const err = await sock.renameSpace("s1", "x").catch((e) => e);
  expect(err).toBeInstanceOf(Unsupported);
  expect(err.message).toBe(OPEN_HERDR_TO_RENAME);
});

test("available is true when the socket accepts a connection", async () => {
  const app = await fakeApp(() => ({ ok: true }));
  expect(await createAppSocket(app.path).available()).toBe(true);
});
