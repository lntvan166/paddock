import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORE_GENERATION,
  CoreClient,
  CoreError,
  CoreGenerationError,
  locateCoreSocket,
} from "@server/herdr-core/socket";

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

type Handler = (req: any, write: (msg: object) => void) => void;

async function fakeCore(handler: Handler) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-core-"));
  const path = join(dir, "default.sock");
  const conns = new Set<any>();
  const server = Bun.listen({
    unix: path,
    socket: {
      open(s) { conns.add(s); },
      close(s) { conns.delete(s); },
      data(s, chunk) {
        // The test requests are tiny, so one chunk is whole lines.
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          handler(JSON.parse(line), (m) => s.write(JSON.stringify(m) + "\n"));
        }
      },
    },
  });
  stop = () => { for (const s of conns) s.end(); server.stop(true); };
  return {
    path,
    raw: (...parts: (string | Uint8Array)[]) => { for (const s of conns) for (const p of parts) s.write(p); },
    broadcast: (m: object) => { for (const s of conns) s.write(JSON.stringify(m) + "\n"); },
    hangUp: () => { for (const s of conns) s.end(); },
  };
}

const ok = (req: any, result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });

test("CORE_GENERATION matches the generated header", async () => {
  const text = await readFile(new URL("../src/shared/herdr-core-api.d.ts", import.meta.url), "utf8");
  const m = text.match(/^\/\/ generation: (\d+)$/m);
  expect(m).not.toBeNull();
  expect(CORE_GENERATION).toBe(Number(m![1]));
});

test("locateCoreSocket follows HC_SOCKET, XDG_RUNTIME_DIR, /run/user, state dir", () => {
  const has = (...ps: string[]) => (p: string) => ps.includes(p);
  expect(locateCoreSocket({ HC_SOCKET: "/x/hc.sock", XDG_RUNTIME_DIR: "/run/u" }, 1000, has("/x/hc.sock", "/run/u/herdr-core/default.sock")))
    .toBe("/x/hc.sock");
  expect(locateCoreSocket({ XDG_RUNTIME_DIR: "/xdg" }, 1000, has("/xdg/herdr-core/default.sock", "/run/user/1000/herdr-core/default.sock")))
    .toBe("/xdg/herdr-core/default.sock");
  expect(locateCoreSocket({}, 1000, has("/run/user/1000/herdr-core/default.sock")))
    .toBe("/run/user/1000/herdr-core/default.sock");
  expect(locateCoreSocket({ HOME: "/h" }, 1000, has("/h/.local/state/herdr-core/default/default.sock")))
    .toBe("/h/.local/state/herdr-core/default/default.sock");
  expect(locateCoreSocket({ HOME: "/h", XDG_STATE_HOME: "/st" }, 1000, has("/st/herdr-core/work/work.sock")), )
    .toBeNull();
  expect(locateCoreSocket({ HOME: "/h", XDG_STATE_HOME: "/st" }, 1000, has("/st/herdr-core/work/work.sock"), "work"))
    .toBe("/st/herdr-core/work/work.sock");
  expect(locateCoreSocket({}, 1000, () => false)).toBeNull();
});

test("PADDOCK_HC_SOCKET overrides every other source", () => {
  expect(locateCoreSocket({ PADDOCK_HC_SOCKET: "/mine.sock", HC_SOCKET: "/x" }, 1000, () => true)).toBe("/mine.sock");
});

test("request returns result and maps a JSON-RPC error to CoreError with data.kind", async () => {
  const core = await fakeCore((req, write) => {
    if (req.method === "terminal.get") {
      if (req.params.terminal === "t9") {
        write({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "no terminal t9", data: { kind: "not_found", hint: "run ls" } } });
      } else write(ok(req, { address: req.params.terminal }));
    }
  });
  const c = new CoreClient(core.path);
  // Two requests on one connection, matched by id.
  expect(await c.request<unknown>("terminal.get", { terminal: "t1" }) as any).toEqual({ address: "t1" });
  const err = await c.request<any>("terminal.get", { terminal: "t9" }).catch((e: any) => e);
  expect(err).toBeInstanceOf(CoreError);
  expect(err.kind).toBe("not_found");
  expect(err.hint).toBe("run ls");
  expect(err.message).toContain("no terminal t9");
  expect(await c.request<unknown>("terminal.get", { terminal: "t2" })).toEqual({ address: "t2" });
  c.close();
});

test("hello refuses generation 2 with CoreGenerationError naming both", async () => {
  const core = await fakeCore((req, write) => write(ok(req, { generation: 2, version: "9", methods: [], features: [], framed: false, core: { id: "c", name: "dev-box" } })));
  const c = new CoreClient(core.path);
  const err = await c.hello().catch((e: any) => e);
  expect(err).toBeInstanceOf(CoreGenerationError);
  expect(err.got).toBe(2);
  expect(err.want).toBe(1);
  expect(err.message).toContain("2");
  expect(err.message).toContain("1");
  c.close();
});

test("hello accepts generation 1", async () => {
  const core = await fakeCore((req, write) => write(ok(req, { generation: 1, version: "0.1.19", methods: [], features: [], framed: false, core: { id: "c", name: "dev-box" } })));
  const c = new CoreClient(core.path);
  expect((await c.hello()).version).toBe("0.1.19");
  c.close();
});

test("subscribe delivers the snapshot then events in seq order, tolerating unknown types", async () => {
  const core = await fakeCore((req, write) => {
    if (req.method === "events.subscribe") write(ok(req, { channel: null, seq: 5, terminals: [{ address: "t1" }] }));
  });
  const snaps: any[] = [];
  const events: any[] = [];
  const c = new CoreClient(core.path);
  const close = await c.subscribe((s) => snaps.push(s), (e) => events.push(e));
  expect(snaps).toHaveLength(1);
  expect(snaps[0].seq).toBe(5);
  core.broadcast({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 5 } });
  core.broadcast({ jsonrpc: "2.0", method: "event", params: { type: "title", seq: 6, terminal: "t1", data: { title: "a" } } });
  core.broadcast({ jsonrpc: "2.0", method: "event", params: { type: "from_the_future", seq: 7, data: {} } });
  await Bun.sleep(50);
  expect(events.map((e) => [e.seq, e.type])).toEqual([[6, "title"], [7, "from_the_future"]]);
  close();
});

test("a missed notification is delivered as a fresh snapshot", async () => {
  const core = await fakeCore((req, write) => {
    if (req.method === "events.subscribe") write(ok(req, { channel: null, seq: 1, terminals: [] }));
  });
  const snaps: any[] = [];
  const c = new CoreClient(core.path);
  const close = await c.subscribe((s) => snaps.push(s), () => {});
  core.broadcast({ jsonrpc: "2.0", method: "missed", params: { seq: 40, terminals: [{ address: "t3" }] } });
  await Bun.sleep(50);
  expect(snaps.map((s) => s.seq)).toEqual([1, 40]);
  close();
});

test("subscribe reports a server-side close through onClose, not after the caller's own close", async () => {
  const core = await fakeCore((req, write) => {
    if (req.method === "events.subscribe") write(ok(req, { channel: null, seq: 1, terminals: [] }));
  });
  let closed = 0;
  const c = new CoreClient(core.path);
  await c.subscribe(() => {}, () => {}, () => { closed++; });
  core.hangUp();
  await Bun.sleep(50);
  expect(closed).toBe(1);

  let closed2 = 0;
  const c2 = new CoreClient(core.path);
  const close = await c2.subscribe(() => {}, () => {}, () => { closed2++; });
  close();
  await Bun.sleep(50);
  expect(closed2).toBe(0);
});

test("a pending request rejects when the connection drops", async () => {
  const core = await fakeCore(() => { /* never answers */ });
  const c = new CoreClient(core.path, 5000);
  const p = c.request<any>("server.status").catch((e: any) => e);
  await Bun.sleep(30);
  core.hangUp();
  const err = await p;
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain("closed");
});

test("a request that never answers rejects after the timeout", async () => {
  const core = await fakeCore(() => { /* mute */ });
  const c = new CoreClient(core.path, 80);
  const err = await c.request<any>("server.status").catch((e: any) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain("timed out");
  c.close();
});

test("an unreachable socket rejects with the path", async () => {
  const c = new CoreClient("/nonexistent/paddock-core.sock", 500);
  const err = await c.request<any>("server.status").catch((e: any) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain("/nonexistent/paddock-core.sock");
});

test("a reply and an event in ONE write reach onSnapshot before onEvent", async () => {
  const core = await fakeCore((req, write) => {
    if (req.method === "events.subscribe") {
      const a = JSON.stringify(ok(req, { channel: null, seq: 1, terminals: [] }));
      const b = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "title", seq: 2, terminal: "t1", data: { title: "x" } } });
      core.raw(a + "\n" + b + "\n");
    }
  });
  const order: string[] = [];
  const c = new CoreClient(core.path);
  const close = await c.subscribe(() => order.push("snapshot"), () => order.push("event"));
  await Bun.sleep(30);
  expect(order).toEqual(["snapshot", "event"]);
  close();
});

test("a multi-byte character split across two writes arrives intact", async () => {
  const core = await fakeCore((req, write) => {
    const bytes = new TextEncoder().encode(JSON.stringify(ok(req, { text: "box \u2500 end" })) + "\n");
    const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte character
    core.raw(bytes.slice(0, cut));
    setTimeout(() => core.raw(bytes.slice(cut)), 30);
  });
  const c = new CoreClient(core.path);
  expect(await c.request<any>("terminal.read", {})).toEqual({ text: "box \u2500 end" });
  c.close();
});

test("an onSnapshot that throws rejects subscribe and closes the stream, never hanging it", async () => {
  const core = await fakeCore((req, write) => {
    if (req.method === "events.subscribe") write(ok(req, { channel: null, seq: 1, terminals: [] }));
  });
  const c = new CoreClient(core.path, 5000);
  let closedCalls = 0;
  const outcome = await Promise.race([
    c.subscribe(() => { throw new Error("snapshot handler broke"); }, () => {}, () => { closedCalls++; })
      .then(() => "resolved", (e: Error) => e.message),
    Bun.sleep(1000).then(() => "hung"),
  ]);
  expect(outcome).toBe("snapshot handler broke");
  // Our own close, not one the caller is told about as a drop.
  await Bun.sleep(30);
  expect(closedCalls).toBe(0);
});

test("closing a client whose request connection never opened logs the failure rather than dropping it", async () => {
  const infos: string[] = [];
  const orig = console.info;
  console.info = (...a: unknown[]) => { infos.push(a.join(" ")); };
  try {
    const c = new CoreClient("/nonexistent/paddock-core.sock", 500);
    // A request that is mid-connect when close() runs; its own rejection is
    // the caller's to see, and close() must not be the place it vanishes.
    const p = c.request<any>("server.status").catch((e: Error) => e);
    c.close();
    await p;
    await Bun.sleep(20);
    expect(infos.some((l) => l.includes("/nonexistent/paddock-core.sock"))).toBe(true);
  } finally {
    console.info = orig;
  }
});
