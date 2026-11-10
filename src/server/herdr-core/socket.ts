/**
 * herdr-core socket client. The ONLY module that speaks the core's wire
 * format: JSON-RPC 2.0, one JSON message per line, over a unix socket.
 *
 * Connection model (docs/probes/2026-11-09-herdr-core.md, "Step 5a"):
 *  - one persistent plain connection carries many requests, matched by `id`;
 *  - `events.subscribe` turns its connection into an event stream, so it gets
 *    a connection of its own.
 * What an open subscription does across a core restart is NOT measured, so
 * any socket close is reported to the caller via `onClose` and the supervisor
 * decides whether to reconnect. Nothing here retries or swallows.
 */
import { join } from "node:path";
import type {
  CoreEvent,
  CoreHelloResult,
  CoreMissed,
  CoreSubscribeResult,
  CoreUnknownEvent,
} from "@shared/herdr-core-api";

/**
 * The protocol generation this build understands. A runtime constant, not an
 * import from the .d.ts (a declaration file has no runtime); a test pins it to
 * the generated `// generation: N` header.
 */
export const CORE_GENERATION = 1;

/** Framed-mode frame kinds (herdr-core `wire.rs`). */
const FRAME_DATA = 0;
const FRAME_CREDIT = 1;
const FRAME_CLOSE = 2;

export class CoreError extends Error {
  kind: string;
  hint?: string;
  constructor(message: string, kind: string, hint?: string) {
    super(message);
    this.name = "CoreError";
    this.kind = kind;
    this.hint = hint;
  }
}

export class CoreGenerationError extends Error {
  got: number;
  want: 1;
  constructor(got: number) {
    super(`herdr-core speaks protocol generation ${got}; paddock supports generation ${CORE_GENERATION} only`);
    this.name = "CoreGenerationError";
    this.got = got;
    this.want = 1;
  }
}

/**
 * Where the core's socket is, or null when none exists. `exists` is injected so
 * the order is testable without a filesystem.
 */
export function locateCoreSocket(
  env: Record<string, string | undefined>,
  uid: number,
  exists: (p: string) => boolean,
  session = "default",
): string | null {
  if (env.PADDOCK_HC_SOCKET) return env.PADDOCK_HC_SOCKET;
  const candidates: string[] = [];
  if (env.HC_SOCKET) candidates.push(env.HC_SOCKET);
  if (env.XDG_RUNTIME_DIR) candidates.push(join(env.XDG_RUNTIME_DIR, "herdr-core", `${session}.sock`));
  candidates.push(`/run/user/${uid}/herdr-core/${session}.sock`);
  const state = env.XDG_STATE_HOME || (env.HOME ? join(env.HOME, ".local", "state") : undefined);
  if (state) candidates.push(join(state, "herdr-core", session, `${session}.sock`));
  return candidates.find(exists) ?? null;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Msg = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: { kind?: string; hint?: string } };
};

/** A line-buffered connection. Calls `onMessage` per decoded line, `onClose` once. */
class Conn {
  private sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  private buf = "";
  /** One decoder per connection: a multi-byte character can straddle two chunks. */
  private decoder = new TextDecoder();
  closed = false;
  private constructor(
    private onMessage: (m: Msg) => void,
    private onClose: (reason: Error) => void,
  ) {}

  static async open(path: string, onMessage: (m: Msg) => void, onClose: (reason: Error) => void): Promise<Conn> {
    const c = new Conn(onMessage, onClose);
    try {
      c.sock = await Bun.connect({
        unix: path,
        socket: {
          data(_s, chunk) { c.feed(c.decoder.decode(chunk, { stream: true })); },
          close() { c.shut(new Error(`herdr-core connection closed (${path})`)); },
          // Ended, not just marked shut: whoever owned this connection forgets
          // it in `onClose`, so nothing would ever close the fd otherwise.
          error(s, e) { c.shut(new Error(`herdr-core socket error (${path}): ${e.message}`)); s.end(); },
        },
      });
    } catch (e) {
      throw new Error(`cannot connect to herdr-core at ${path}: ${(e as Error).message}`);
    }
    return c;
  }

  private feed(text: string) {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: Msg;
      try { msg = JSON.parse(line); }
      catch (e) {
        // A line that is not JSON means the stream is no longer trustworthy.
        this.close(new Error(`herdr-core sent a line that is not JSON: ${line.slice(0, 80)}`));
        return;
      }
      this.onMessage(msg);
      // A handler may close this connection mid-chunk; the rest of the chunk
      // belongs to a stream nobody is listening to any more.
      if (this.closed) return;
    }
  }

  send(msg: object) {
    this.sock!.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  private shut(reason: Error) {
    if (this.closed) return;
    this.closed = true;
    this.onClose(reason);
  }

  /** Close from our side. `reason` is what pending work is told. */
  close(reason = new Error("herdr-core connection closed by paddock")) {
    this.shut(reason);
    this.sock?.end();
  }
}

export class CoreClient {
  private conn: Promise<Conn> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private streams = new Set<Conn>();

  constructor(private path: string, private timeoutMs = 10_000) {}

  private connect(): Promise<Conn> {
    if (!this.conn) {
      const p = Conn.open(
        this.path,
        (m) => this.onReply(m),
        (reason) => {
          this.conn = null;
          const all = [...this.pending.values()];
          this.pending.clear();
          for (const w of all) { clearTimeout(w.timer); w.reject(reason); }
        },
      );
      this.conn = p;
      p.catch(() => { if (this.conn === p) this.conn = null; });
    }
    return this.conn;
  }

  private onReply(m: Msg) {
    if (m.id === undefined) return;
    const w = this.pending.get(m.id);
    if (!w) return;
    this.pending.delete(m.id);
    clearTimeout(w.timer);
    if (m.error) {
      w.reject(new CoreError(m.error.message, m.error.data?.kind ?? "unknown", m.error.data?.hint));
    } else {
      w.resolve(m.result);
    }
  }

  async request<T>(method: string, params: object = {}): Promise<T> {
    const conn = await this.connect();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`herdr-core ${method} timed out after ${this.timeoutMs} ms (${this.path})`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { conn.send({ id, method, params }); }
      catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  /**
   * The first paint of `terminal`, as an observer: never types, never
   * resizes (`observe: true`), so the operator's own view in the app is not
   * touched. Its own framed connection, closed once the paint has gone quiet.
   *
   * Framed mode (herdr-core `wire.rs`): after the hello's reply LINE, every
   * message is `[channel u32 LE][kind u8][len u32 LE][payload]`. Channel 0
   * carries JSON-RPC; the attach answers with its own channel, which then
   * carries the paint as DATA frames. CREDIT returns what was read, CLOSE
   * ends the channel.
   *
   * The paint has no end marker, so it is taken as done after `QUIET_MS`
   * with nothing new, or `MAX_PAINT_MS` after it started on a terminal that
   * never stops printing (the screen then includes those updates, which is
   * still the screen).
   */
  observePaint(terminal: string, cols: number, rows: number, history: number): Promise<Uint8Array> {
    const QUIET_MS = 40;
    const MAX_PAINT_MS = 400;
    const path = this.path;
    const timeoutMs = this.timeoutMs;
    return new Promise<Uint8Array>((resolve, reject) => {
      let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;
      let buf = new Uint8Array(0);
      let framed = false;
      let channel: number | null = null;
      const chunks: Uint8Array[] = [];
      let settled = false;
      let quiet: ReturnType<typeof setTimeout> | null = null;
      let cap: ReturnType<typeof setTimeout> | null = null;
      const deadline = setTimeout(() => fail(new Error(`herdr-core: no paint from ${terminal} within ${timeoutMs} ms`)), timeoutMs);

      const send = (ch: number, kind: number, payload: Uint8Array) => {
        const out = new Uint8Array(9 + payload.length);
        const v = new DataView(out.buffer);
        v.setUint32(0, ch, true);
        out[4] = kind;
        v.setUint32(5, payload.length, true);
        out.set(payload, 9);
        sock?.write(out);
      };
      const cleanup = () => {
        settled = true;
        clearTimeout(deadline);
        if (quiet) clearTimeout(quiet);
        if (cap) clearTimeout(cap);
        if (channel !== null) send(channel, FRAME_CLOSE, new Uint8Array(0));
        sock?.end();
      };
      const fail = (e: Error) => { if (settled) return; cleanup(); reject(e); };
      const done = () => {
        if (settled) return;
        cleanup();
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        resolve(out);
      };

      const onFrame = (ch: number, kind: number, payload: Uint8Array) => {
        if (ch === 0 && kind === FRAME_DATA) {
          let reply: Msg;
          try { reply = JSON.parse(new TextDecoder().decode(payload)); }
          catch { fail(new Error("herdr-core sent a control frame that is not JSON")); return; }
          if (reply.id !== 1) return;
          if (reply.error) {
            fail(new CoreError(reply.error.message, reply.error.data?.kind ?? "unknown", reply.error.data?.hint));
            return;
          }
          channel = Number(reply.result?.channel);
          return;
        }
        if (channel === null || ch !== channel) return;
        if (kind === FRAME_DATA) {
          chunks.push(payload);
          const credit = new Uint8Array(4);
          new DataView(credit.buffer).setUint32(0, payload.length, true);
          send(channel, FRAME_CREDIT, credit);
          if (!cap) cap = setTimeout(done, MAX_PAINT_MS);
          if (quiet) clearTimeout(quiet);
          quiet = setTimeout(done, QUIET_MS);
        } else if (kind === FRAME_CLOSE) {
          if (chunks.length > 0) done();
          else fail(new Error(`herdr-core closed the view of ${terminal} before painting it`));
        }
      };

      const feed = (chunk: Uint8Array) => {
        const next = new Uint8Array(buf.length + chunk.length);
        next.set(buf); next.set(chunk, buf.length); buf = next;
        if (!framed) {
          const nl = buf.indexOf(10);
          if (nl < 0) return;
          let hello: Msg;
          try { hello = JSON.parse(new TextDecoder().decode(buf.subarray(0, nl))); }
          catch { fail(new Error("herdr-core answered the framed hello with something that is not JSON")); return; }
          buf = buf.slice(nl + 1);
          if (hello.error) { fail(new CoreError(hello.error.message, hello.error.data?.kind ?? "unknown")); return; }
          framed = true;
          const req = { jsonrpc: "2.0", id: 1, method: "terminal.attach", params: { terminal, observe: true, cols, rows, history } };
          send(0, FRAME_DATA, new TextEncoder().encode(JSON.stringify(req)));
        }
        while (!settled && buf.length >= 9) {
          const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const ch = v.getUint32(0, true);
          const kind = buf[4]!;
          const len = v.getUint32(5, true);
          if (buf.length < 9 + len) return;
          const payload = buf.slice(9, 9 + len);
          buf = buf.slice(9 + len);
          onFrame(ch, kind, payload);
        }
      };

      Bun.connect({
        unix: path,
        socket: {
          data(_s, chunk) { feed(new Uint8Array(chunk)); },
          close() { fail(new Error(`herdr-core closed the connection before the paint of ${terminal}`)); },
          error(s, e) { fail(new Error(`herdr-core socket error (${path}): ${e.message}`)); s.end(); },
        },
      }).then((s) => {
        sock = s;
        if (settled) { s.end(); return; }
        s.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { framed: true, generation: CORE_GENERATION } }) + "\n");
      }, (e: Error) => fail(new Error(`cannot connect to herdr-core at ${path}: ${e.message}`)));
    });
  }

  async hello(): Promise<CoreHelloResult> {
    const res = await this.request<CoreHelloResult>("hello", {});
    if (res.generation !== CORE_GENERATION) throw new CoreGenerationError(res.generation);
    return res;
  }

  /**
   * Opens a dedicated connection, subscribes, and resolves with a closer once
   * the snapshot has been delivered. A `missed` notification is delivered as a
   * fresh snapshot through `onSnapshot` (callers drop events not above its
   * seq). Heartbeats are consumed here. `onClose` fires on ANY close that the
   * caller did not ask for, with the reason; closing via the returned function
   * does not fire it.
   */
  async subscribe(
    onSnapshot: (s: CoreSubscribeResult) => void,
    onEvent: (e: CoreEvent | CoreUnknownEvent) => void,
    onClose: (reason: Error) => void = () => {},
  ): Promise<() => void> {
    const SUB_ID = 1;
    let wantClose = false;
    let settled = false;
    let conn!: Conn;
    let ack!: (r: CoreSubscribeResult) => void;
    let nack!: (e: Error) => void;
    const acked = new Promise<CoreSubscribeResult>((res, rej) => { ack = res; nack = rej; });
    const timer = setTimeout(
      () => { conn?.close(new Error(`herdr-core events.subscribe timed out after ${this.timeoutMs} ms`)); },
      this.timeoutMs,
    );

    conn = await Conn.open(
      this.path,
      (m) => {
        if (m.id === SUB_ID) {
          if (m.error) nack(new CoreError(m.error.message, m.error.data?.kind ?? "unknown", m.error.data?.hint));
          else {
            // Deliver the snapshot HERE, synchronously: a chunk can carry the
            // reply and the first events together, and they must land after it.
            settled = true;
            clearTimeout(timer);
            try {
              onSnapshot(m.result as CoreSubscribeResult);
            } catch (e) {
              // Settled already, so the close handler will not reject `acked`:
              // reject it here, or `subscribe` waits forever. Our own close —
              // the caller hears it as this rejection, not as a drop.
              const err = e instanceof Error ? e : new Error(String(e));
              wantClose = true;
              nack(err);
              conn.close(err);
              return;
            }
            ack(m.result as CoreSubscribeResult);
          }
          return;
        }
        if (m.method === "event") onEvent(m.params as CoreEvent | CoreUnknownEvent);
        else if (m.method === "missed") {
          const p = m.params as CoreMissed;
          onSnapshot({ channel: null, seq: p.seq, terminals: p.terminals });
        }
        // "heartbeat" ({seq}) only proves the stream is alive; nothing to do.
      },
      (reason) => {
        this.streams.delete(conn);
        clearTimeout(timer);
        if (!settled) nack(reason);
        else if (!wantClose) onClose(reason);
      },
    );
    this.streams.add(conn);
    conn.send({ id: SUB_ID, method: "events.subscribe", params: {} });

    try { await acked; }
    catch (e) { wantClose = true; conn.close(); throw e; }
    finally { clearTimeout(timer); }
    return () => { wantClose = true; conn.close(); };
  }

  /** Close the request connection and any subscription; pending requests reject. */
  close() {
    for (const s of [...this.streams]) s.close();
    // A connect that failed was already rejected to the request awaiting it;
    // said here too rather than dropped, since nobody awaits this close.
    this.conn?.then(
      (c) => c.close(),
      (e: Error) => console.info(`herdr-core: closing a connection that never opened: ${e.message}`),
    );
  }
}
