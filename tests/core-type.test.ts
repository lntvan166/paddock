import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreClient, CoreError } from "@server/herdr-core/socket";

/**
 * `typeText`: text into a terminal WITHOUT pressing Enter, which no plain
 * request can do (`terminal.send` always submits, `terminal.keys` has no key
 * for `à` or `?`). Measured on a throwaway Claude Code question dialog
 * (docs/probes/2026-11-09-herdr-core.md, step 7): a typing attach that sends
 * the bytes as AUTOMATIC_INPUT typed `chào ?` into the free-text row exactly,
 * and the terminal's size never moved.
 *
 * Why each part of the request is what it is (herdr-core `viewers.rs`):
 *  - `observe: false`, because an observer's input is dropped;
 *  - `resumed: true`, so the attach is not "active": the core sizes a
 *    terminal by its most recently active typing viewer, and an attach that
 *    has never been active cannot take that from the operator's own window;
 *  - `cols`/`rows` the terminal's own, so even with no other viewer the size
 *    it would set is the size it already has;
 *  - AUTOMATIC_INPUT (kind 6), not DATA: DATA counts as a person typing,
 *    which makes the attach the active viewer.
 * Then one more request on the same connection: the core handles input
 * frames as it reads them, so its reply means the bytes are in.
 */

const DATA = 0, CLOSE = 2, AUTOMATIC_INPUT = 6;
const CH = 9;

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
  attachError?: { code: number; message: string; data?: { kind: string } };
  /** What the attach reply says about AUTOMATIC_INPUT. */
  automatic?: boolean;
  /** Never answer the confirming request. */
  muteConfirm?: boolean;
}

async function fakeCore(opts: FakeOpts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-type-"));
  const path = join(dir, "core.sock");
  const seen = { requests: [] as any[], frames: [] as { kind: number; text: string }[], ended: false };
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
            seen.requests.push(req);
            if (req.method === "terminal.attach") {
              if (opts.attachError) {
                s.write(frame(0, DATA, JSON.stringify({ jsonrpc: "2.0", id: req.id, error: opts.attachError })));
                continue;
              }
              s.write(frame(0, DATA, JSON.stringify({
                jsonrpc: "2.0", id: req.id, result: { channel: CH, automatic_input: opts.automatic ?? true },
              })));
              // The first paint every attach gets; a typing attach ignores it.
              s.write(frame(CH, DATA, "\x1b[2Jscreen"));
            } else if (!opts.muteConfirm) {
              s.write(frame(0, DATA, JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { address: "t7" } })));
            }
          } else if (ch === CH) {
            seen.frames.push({ kind, text: new TextDecoder().decode(payload) });
          }
        }
      },
    },
  });
  stop = () => server.stop(true);
  return { path, seen };
}

test("types the text as automatic input on a typing attach that cannot resize", async () => {
  const core = await fakeCore();
  await new CoreClient(core.path, 2000).typeText("t7", "chào ?", { cols: 200, rows: 120 });
  const attach = core.seen.requests[0];
  expect(attach.method).toBe("terminal.attach");
  expect(attach.params).toEqual({ terminal: "t7", observe: false, resumed: true, cols: 200, rows: 120, history: 0 });
  expect(core.seen.frames[0]).toEqual({ kind: AUTOMATIC_INPUT, text: "chào ?" });
});

test("resolves only after a later request on the same connection is answered, then closes", async () => {
  const core = await fakeCore();
  await new CoreClient(core.path, 2000).typeText("t7", "ok", { cols: 80, rows: 24 });
  expect(core.seen.requests.map((r) => r.method)).toEqual(["terminal.attach", "terminal.get"]);
  expect(core.seen.requests[1].params).toEqual({ terminal: "t7" });
  await Bun.sleep(20);
  expect(core.seen.frames.map((f) => f.kind)).toEqual([AUTOMATIC_INPUT, CLOSE]);
  expect(core.seen.ended).toBe(true);
});

test("never types as a person: a core without automatic input is refused, and nothing is sent", async () => {
  // Falling back to DATA would make paddock the active viewer, whose size the
  // terminal then takes.
  const core = await fakeCore({ automatic: false });
  const e = await new CoreClient(core.path, 2000).typeText("t7", "ok", { cols: 80, rows: 24 }).catch((x) => x);
  expect(e.message).toMatch(/automatic input/);
  expect(core.seen.frames.filter((f) => f.kind !== CLOSE)).toEqual([]);
});

test("an attach the core refuses rejects with its error", async () => {
  const core = await fakeCore({ attachError: { code: -32000, message: "t7 has finished", data: { kind: "finished" } } });
  const e = await new CoreClient(core.path, 2000).typeText("t7", "ok", { cols: 80, rows: 24 }).catch((x) => x);
  expect(e).toBeInstanceOf(CoreError);
  expect(e.message).toBe("t7 has finished");
});

test("a confirmation that never comes rejects within the timeout", async () => {
  const core = await fakeCore({ muteConfirm: true });
  const e = await new CoreClient(core.path, 200).typeText("t7", "ok", { cols: 80, rows: 24 }).catch((x) => x);
  expect(e.message).toMatch(/timed out/);
});

test("no core at the path is a connect error", async () => {
  const e = await new CoreClient("/nonexistent/core.sock", 300)
    .typeText("t7", "ok", { cols: 80, rows: 24 }).catch((x) => x);
  expect(e.message).toMatch(/cannot connect to herdr-core/);
});
