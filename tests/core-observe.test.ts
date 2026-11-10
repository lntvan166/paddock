import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreClient, CoreError } from "@server/herdr-core/socket";

/**
 * `observePaint`: one framed connection, `terminal.attach` with
 * `observe: true`, the first paint collected, then closed.
 *
 * Framed mode is `[channel u32 LE][kind u8][len u32 LE][payload]` after the
 * hello's reply line (herdr-core `wire.rs`); channel 0 carries JSON-RPC, the
 * attach gets its own channel.
 */

const DATA = 0, CREDIT = 1, CLOSE = 2;

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

let stop = () => {};
afterEach(() => stop());

interface FakeOpts {
  /** Chunks of the first paint, sent as separate DATA frames. */
  paint?: string[];
  /** Reply to the attach with this error instead. */
  attachError?: { code: number; message: string; data?: { kind: string } };
  /** Never send any paint. */
  silent?: boolean;
}

async function fakeCore(opts: FakeOpts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-observe-"));
  const path = join(dir, "core.sock");
  const seen: { attach?: any; credits: number; closedChannel: boolean; ended: boolean } = {
    credits: 0, closedChannel: false, ended: false,
  };
  const server = Bun.listen({
    unix: path,
    socket: {
      open(s) { (s as any).buf = new Uint8Array(0); (s as any).framed = false; },
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
            if (opts.attachError) {
              s.write(frame(0, DATA, JSON.stringify({ jsonrpc: "2.0", id: req.id, error: opts.attachError })));
              continue;
            }
            s.write(frame(0, DATA, JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { channel: 7 } })));
            if (!opts.silent) for (const c of opts.paint ?? ["hello"]) s.write(frame(7, DATA, c));
          } else if (ch === 7 && kind === CREDIT) seen.credits++;
          else if (ch === 7 && kind === CLOSE) seen.closedChannel = true;
        }
      },
    },
  });
  stop = () => server.stop(true);
  return { path, seen };
}

test("observes without typing or resizing, at the terminal's own size, and returns the paint", async () => {
  const { path, seen } = await fakeCore({ paint: ["\x1b[31mred", "\x1b[0m done"] });
  const client = new CoreClient(path, 2000);
  const paint = await client.observePaint("t7", 120, 40, 50);
  expect(new TextDecoder().decode(paint)).toBe("\x1b[31mred\x1b[0m done");
  expect(seen.attach.method).toBe("terminal.attach");
  expect(seen.attach.params).toMatchObject({ terminal: "t7", observe: true, cols: 120, rows: 40, history: 50 });
  await Bun.sleep(30);
  // Credit returned for what was read, the channel closed, the socket ended.
  expect(seen.credits).toBeGreaterThan(0);
  expect(seen.closedChannel).toBe(true);
  expect(seen.ended).toBe(true);
});

test("an attach the core refuses rejects with its error, not an empty screen", async () => {
  const { path } = await fakeCore({ attachError: { code: -32000, message: "no terminal t9", data: { kind: "not_found" } } });
  const e = await new CoreClient(path, 2000).observePaint("t9", 80, 24, 0).catch((x) => x);
  expect(e).toBeInstanceOf(CoreError);
  expect(e.message).toBe("no terminal t9");
});

test("a core that never paints rejects within the timeout", async () => {
  const { path } = await fakeCore({ silent: true });
  const started = Date.now();
  const e = await new CoreClient(path, 300).observePaint("t7", 80, 24, 0).catch((x) => x);
  expect(e).toBeInstanceOf(Error);
  expect(e.message).toMatch(/no paint/);
  expect(Date.now() - started).toBeLessThan(1500);
});

test("no core at the path is a connect error", async () => {
  const e = await new CoreClient("/nonexistent/core.sock", 300).observePaint("t7", 80, 24, 0).catch((x) => x);
  expect(e.message).toMatch(/cannot connect to herdr-core/);
});
