import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Probe } from "@server/lifecycle/state";
import {
  checkTunnelState, controlSocket, isTunnelState, removeTunnelState,
  tunnelStateFile, writeTunnelState, type TunnelState,
} from "@server/tunnel/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-tunnel-state-"));

const STATE: TunnelState = {
  pid: 4242,
  args: "paddock tunnel --detach",
  url: "https://example-tunnel.trycloudflare.com",
  control: "/base/operator/.config/paddock/tunnel.sock",
  publishing: null,
  startedAt: 1_000,
  until: null,
};

const alive: Probe = { isAlive: () => true, argsOf: () => STATE.args };
const dead: Probe = { isAlive: () => false, argsOf: () => null };

test("the tunnel's file is NOT the paddock's file", async () => {
  // The whole reason this module exists. `recordState` is first-instance-wins
  // per config dir, and `--publish-running` runs beside a recorded paddock by
  // design — so sharing the file would make one of the two untrackable.
  const d = await dir();
  expect(tunnelStateFile(d)).not.toBe(join(d, "paddock.state.json"));
  expect(tunnelStateFile(d)).toBe(join(d, "paddock.tunnel.json"));
});

test("a written record round-trips, at 0600", async () => {
  const d = await dir();
  await writeTunnelState(d, STATE);
  expect(JSON.parse(await readFile(tunnelStateFile(d), "utf8"))).toEqual(STATE);
  // The file names a live socket path and a public URL. Same mode as every
  // other record in this directory.
  expect((await stat(tunnelStateFile(d))).mode & 0o777).toBe(0o600);
});

test("a live record reads back as running", async () => {
  const d = await dir();
  await writeTunnelState(d, STATE);
  const got = await checkTunnelState(d, alive);
  expect(got.kind).toBe("running");
  if (got.kind !== "running") throw new Error("unreachable");
  expect(got.state.url).toBe(STATE.url);
});

test("no file is absence, not an error", async () => {
  expect((await checkTunnelState(await dir(), alive)).kind).toBe("none");
});

test("a dead pid is stale, and the record survives to be reported", async () => {
  const d = await dir();
  await writeTunnelState(d, STATE);
  const got = await checkTunnelState(d, dead);
  expect(got.kind).toBe("stale");
  if (got.kind !== "stale") throw new Error("unreachable");
  expect(got.state.pid).toBe(4242);
});

test("a pid that is now something else is a mismatch, not running", async () => {
  const d = await dir();
  await writeTunnelState(d, STATE);
  const got = await checkTunnelState(d, { isAlive: () => true, argsOf: () => "vim" });
  expect(got.kind).toBe("mismatch");
});

test("a record missing url or control is unusable, not running", async () => {
  // `pair` renders a QR of `${url}/#${code}` and connects to `control`. A
  // record without them would draw a QR reading "undefined/#H2FK-68CG" — a
  // code handed out, on a URL that goes nowhere. The shape guard is what
  // stops that being a runtime surprise.
  expect(isTunnelState({ ...STATE, url: undefined })).toBe(false);
  expect(isTunnelState({ ...STATE, control: undefined })).toBe(false);
  expect(isTunnelState(STATE)).toBe(true);

  const d = await dir();
  const { url: _drop, ...noUrl } = STATE;
  await writeFile(tunnelStateFile(d), JSON.stringify(noUrl));
  // Announced, never silent: this arm makes `pair` say "no tunnel" while one
  // is plainly running, so the operator must be told which file was ignored.
  const said: string[] = [];
  expect((await checkTunnelState(d, alive, (l) => said.push(l))).kind).toBe("none");
  expect(said.join("\n")).toContain("paddock.tunnel.json");
});

test("removing takes the socket with it", async () => {
  // A stale socket left behind is a path that accepts a connection and never
  // answers — `pair` would hang against a tunnel that has already gone.
  const d = await dir();
  await writeTunnelState(d, STATE);
  await writeFile(controlSocket(d), "");
  await removeTunnelState(d);
  expect((await checkTunnelState(d, alive)).kind).toBe("none");
  expect(await Bun.file(controlSocket(d)).exists()).toBe(false);
});
