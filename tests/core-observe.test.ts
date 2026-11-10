import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreClient, CoreError } from "@server/herdr-core/socket";

/**
 * `observe`: one framed connection, `terminal.attach` with `observe: true`
 * and `resize_notifications: true`, kept open; every DATA credited.
 *
 * Framed mode is `[channel u32 LE][kind u8][len u32 LE][payload]` after the
 * hello's reply line (herdr-core `wire.rs`); channel 0 carries JSON-RPC, the
 * attach gets its own channel.
 */

const DATA = 0, CREDIT = 1, CLOSE = 2, RESIZE = 3;
const CH = 7;

function frame(channel: number, kind: number, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(9 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, channel, true);
  out[4] = kind;
  v.setUint32(5, body.length, true);
  out.set(body, 9);
  return out;
}

const size = (cols: number, rows: number) => {
  const b = new Uint8Array(4);
  const v = new DataView(b.buffer);
  v.setUint16(0, cols, true);
  v.setUint16(2, rows, true);
  return b;
};

let stop = () => {};
afterEach(() => stop());

interface FakeOpts {
  attachError?: { code: number; message: string; data?: { kind: string } };
  /** Never answer the attach. */
  mute?: boolean;
  /** Sent right after the attach is accepted: RESIZE then these DATA chunks. */
  paint?: string[];
  cols?: number;
  rows?: number;
}

async function fakeCore(opts: FakeOpts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-observe-"));
  const path = join(dir, "core.sock");
  const seen = { attach: undefined as any, credits: 0, closedChannel: false, ended: false };
  let client: any = null;
  const server = Bun.listen({
    unix: path,
    socket: {
      open(s) { (s as any).buf = new Uint8Array(0); (s as any).framed = false; client = s; },
      close() { seen.ended = true; },
      data(s, chunk) {
        const st = s as any;
        const next = new Uint8Array(st.buf.length + chunk.length);
        next.set(st.buf); next.set(chunk, st.buf.length); st.buf = next;
        if (!st.framed) {
          const nl = st.buf.indexOf(10);
          if (nl < 0) return;
          const hello = JSON.parse(new TextDecoder().decode(st.buf.slice(0, nl)));
          st.buf = st.buf.slice(nl + 1);
          st.framed = true;
          s.write(JSON.stringify({ jsonrpc: "2.0", id: hello.id, result: { generation: 1 } }) + "\n");
        }
        while (st.buf.length >= 9) {
          const v = new DataView(st.buf.buffer, st.buf.byteOffset);
          const ch = v.getUint32(0, true), kind = st.buf[4], len = v.getUint32(5, true);
          if (st.buf.length < 9 + len) return;
          const payload = st.buf.slice(9, 9 + len);
          st.buf = st.buf.slice(9 + len);
          if (ch === 0 && kind === DATA) {
            const req = JSON.parse(new TextDecoder().decode(payload));
            seen.attach = req;
            if (opts.mute) continue;
            if (opts.attachError) {
              s.write(frame(0, DATA, JSON.stringify({ jsonrpc: "2.0", id: req.id, error: opts.attachError })));
              continue;
            }
            s.write(frame(0, DATA, JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { channel: CH } })));
            s.write(frame(CH, RESIZE, size(opts.cols ?? 80, opts.rows ?? 24)));
            for (const c of opts.paint ?? []) s.write(frame(CH, DATA, c));
          } else if (ch === CH && kind === CREDIT) seen.credits++;
          else if (ch === CH && kind === CLOSE) seen.closedChannel = true;
        }
      },
    },
  });
  stop = () => server.stop(true);
  return {
    path, seen,
    push: (text: string) => client.write(frame(CH, DATA, text)),
    resize: (cols: number, rows: number) => client.write(frame(CH, RESIZE, size(cols, rows))),
    endView: (why: string) => client.write(frame(CH, CLOSE, why)),
  };
}

function recorder() {
  const got = { data: "", resizes: [] as [number, number][], closes: [] as string[] };
  return {
    got,
    h: {
      onData: (b: Uint8Array) => { got.data += new TextDecoder().decode(b); },
      onResize: (c: number, r: number) => { got.resizes.push([c, r]); },
      onClose: (e: Error) => { got.closes.push(e.message); },
    },
  };
}

test("observes without typing or resizing, and asks to be told of size changes", async () => {
  const core = await fakeCore({ paint: ["\x1b[31mred"], cols: 120, rows: 40 });
  const { got, h } = recorder();
  const close = await new CoreClient(core.path, 2000).observe("t7", { cols: 120, rows: 40, history: 50 }, h);
  await Bun.sleep(30);
  expect(core.seen.attach.method).toBe("terminal.attach");
  expect(core.seen.attach.params).toMatchObject({
    terminal: "t7", observe: true, resize_notifications: true, cols: 120, rows: 40, history: 50,
  });
  expect(got.resizes).toEqual([[120, 40]]);
  expect(got.data).toBe("\x1b[31mred");
  close();
});

test("the stream stays open: later output, and a size change, arrive as they happen", async () => {
  const core = await fakeCore({ paint: ["a"] });
  const { got, h } = recorder();
  const close = await new CoreClient(core.path, 2000).observe("t7", { cols: 80, rows: 24, history: 0 }, h);
  await Bun.sleep(20);
  core.push("b");
  core.resize(100, 30);
  await Bun.sleep(30);
  expect(got.data).toBe("ab");
  expect(got.resizes.at(-1)).toEqual([100, 30]);
  // Every DATA was credited, or the core would stop sending at its window.
  expect(core.seen.credits).toBe(2);
  close();
});

test("closing from paddock closes the channel and the socket, and is not reported as a loss", async () => {
  const core = await fakeCore({ paint: ["a"] });
  const { got, h } = recorder();
  const close = await new CoreClient(core.path, 2000).observe("t7", { cols: 80, rows: 24, history: 0 }, h);
  close();
  await Bun.sleep(30);
  expect(core.seen.closedChannel).toBe(true);
  expect(core.seen.ended).toBe(true);
  expect(got.closes).toEqual([]);
});

test("the core ending the view is reported once, with its reason", async () => {
  const core = await fakeCore({ paint: ["a"] });
  const { got, h } = recorder();
  await new CoreClient(core.path, 2000).observe("t7", { cols: 80, rows: 24, history: 0 }, h);
  core.endView('{"reason":"restarted"}');
  await Bun.sleep(30);
  expect(got.closes).toHaveLength(1);
  expect(got.closes[0]).toContain("restarted");
});

test("an attach the core refuses rejects with its error", async () => {
  const core = await fakeCore({ attachError: { code: -32000, message: "no terminal t9", data: { kind: "not_found" } } });
  const e = await new CoreClient(core.path, 2000).observe("t9", { cols: 80, rows: 24, history: 0 }, recorder().h).catch((x) => x);
  expect(e).toBeInstanceOf(CoreError);
  expect(e.message).toBe("no terminal t9");
});

test("an attach never answered rejects within the timeout", async () => {
  const core = await fakeCore({ mute: true });
  const started = Date.now();
  const e = await new CoreClient(core.path, 200).observe("t7", { cols: 80, rows: 24, history: 0 }, recorder().h).catch((x) => x);
  expect(e.message).toMatch(/timed out/);
  expect(Date.now() - started).toBeLessThan(1500);
});

test("no core at the path is a connect error", async () => {
  const e = await new CoreClient("/nonexistent/core.sock", 300)
    .observe("t7", { cols: 80, rows: 24, history: 0 }, recorder().h).catch((x) => x);
  expect(e.message).toMatch(/cannot connect to herdr-core/);
});
