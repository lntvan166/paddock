import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pairing } from "@server/tunnel/pairing";
import { askControl, serveControl } from "@server/tunnel/control";

const sock = async () =>
  join(await mkdtemp(join(tmpdir(), "paddock-control-")), "tunnel.sock");

test("the socket answers the current code, its expiry, and the URL", async () => {
  const s = await sock();
  const pairing = new Pairing({ bytes: () => new Uint8Array(8).fill(7) });
  const srv = serveControl({
    socket: s,
    url: () => "https://example-tunnel.trycloudflare.com",
    current: () => pairing.current(),
  });
  try {
    const got = await askControl(s);
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("unreachable");
    expect(got.answer.code).toBe(pairing.current().code);
    expect(got.answer.url).toBe("https://example-tunnel.trycloudflare.com");
    expect(got.answer.expiresAt).toBe(pairing.current().expiresAt);
  } finally {
    srv.stop();
  }
});

test("asking MINTS, so the code handed over is never a spent one", async () => {
  // The reason this is a socket and not a field in the state file. `current()`
  // mints lazily, so the code only advances when something asks — and asking
  // is exactly what this does. An operator running `paddock pair` after the
  // TTL lapsed gets a fresh code with its full ten minutes ahead of it, not an
  // expired one they will type and watch fail.
  const s = await sock();
  let now = 0;
  let n = 0;
  const pairing = new Pairing({
    now: () => now,
    bytes: () => new Uint8Array(8).fill(n++),
  });
  const first = pairing.current().code;
  const srv = serveControl({ socket: s, url: () => "https://x.example.com", current: () => pairing.current() });
  try {
    now = 10_000_000; // well past CODE_TTL_MS
    const got = await askControl(s);
    if (!got.ok) throw new Error("unreachable");
    expect(got.answer.code).not.toBe(first);
    expect(got.answer.expiresAt).toBeGreaterThan(now);
  } finally {
    srv.stop();
  }
});

test("a socket nothing is listening on is a REASON, not an absence", async () => {
  // `pair` must never render "no tunnel is running" for this case: the state
  // file says one is, and reporting the two the same way sends the operator
  // to start a tunnel that is already up.
  const got = await askControl(await sock());
  expect(got.ok).toBe(false);
  if (got.ok) throw new Error("unreachable");
  expect(got.detail).not.toBe("");
});

test("the control socket serves ONE path and nothing else", async () => {
  // It runs beside a gate whose job is deciding what the public may reach.
  // This socket is not reachable from the tunnel at all, but a second route
  // added here later would be one more thing to have that argument about.
  const s = await sock();
  const srv = serveControl({
    socket: s,
    url: () => "https://x.example.com",
    current: () => ({ code: "AAAABBBB", expiresAt: 1 }),
  });
  try {
    const res = await fetch("http://localhost/something-else", { unix: s });
    expect(res.status).toBe(404);
  } finally {
    srv.stop();
  }
});

test("asking a stopped tunnel fails as a reason, and the path is gone", async () => {
  // WHAT THIS DOES NOT COVER, said plainly: `srv.stop(true)` is not verifiable
  // from here. Once the path is unlinked a leaked listener is bound to an
  // unlinked inode and unreachable by definition, so removing that call leaves
  // every assertion below still passing — measured, not assumed. It stays as
  // defence (and `index.ts` exits the process after teardown, which masks a
  // leak anyway); this test covers the composite the CALLER depends on, which
  // is that asking a stopped tunnel neither hangs nor looks like success.
  const s = await sock();
  const srv = serveControl({
    socket: s,
    url: () => "https://x.example.com",
    current: () => ({ code: "AAAABBBB", expiresAt: 1 }),
  });
  expect((await askControl(s)).ok).toBe(true);
  srv.stop();
  await Bun.sleep(20); // the unlink is deliberately not awaited inside stop()
  const after = await askControl(s);
  expect(after.ok).toBe(false);
  expect(await Bun.file(s).exists()).toBe(false);
});
