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
const FRAME_RESIZE = 3;
const FRAME_AUTOMATIC_INPUT = 6;

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

interface FramedHandlers {
  /** The hello was answered: the connection is framed now. */
  ready(): void;
  /** A JSON-RPC reply on channel 0. */
  reply(msg: Msg): void;
  /** A frame on any other channel. */
  frame(channel: number, kind: number, payload: Uint8Array): void;
  /** The reason given when the socket closes without being asked to. */
  closed(): string;
  /** Once, at the end: `null` when paddock ended it, else why it ended. */
  ended(reason: Error | null): void;
}

interface Framed {
  /** The attach's channel, once known: `end` closes it, `credit` credits it. */
  channel: number | null;
  request(id: number, method: string, params: object): void;
  send(channel: number, kind: number, payload: Uint8Array): void;
  credit(n: number): void;
  end(reason: Error | null): void;
}

/**
 * One framed connection (herdr-core `wire.rs`): the hello's reply comes as a
 * LINE, then every message is `[channel u32 LE][kind u8][len u32 LE][payload]`,
 * channel 0 carrying JSON-RPC. Used by the attaches, which each need a
 * connection of their own.
 */
function framedConnection(path: string, h: FramedHandlers): Framed {
  let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  let buf = new Uint8Array(0);
  let framed = false;
  let over = false;

  const wire: Framed = {
    channel: null,
    send(ch, kind, payload) {
      const out = new Uint8Array(9 + payload.length);
      const v = new DataView(out.buffer);
      v.setUint32(0, ch, true);
      out[4] = kind;
      v.setUint32(5, payload.length, true);
      out.set(payload, 9);
      sock?.write(out);
    },
    request(id, method, params) {
      wire.send(0, FRAME_DATA, new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    },
    credit(n) {
      if (wire.channel === null) return;
      const credit = new Uint8Array(4);
      new DataView(credit.buffer).setUint32(0, n, true);
      wire.send(wire.channel, FRAME_CREDIT, credit);
    },
    end(reason) {
      if (over) return;
      over = true;
      if (wire.channel !== null) wire.send(wire.channel, FRAME_CLOSE, new Uint8Array(0));
      sock?.end();
      h.ended(reason);
    },
  };

  const feed = (chunk: Uint8Array) => {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf); next.set(chunk, buf.length); buf = next;
    if (!framed) {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      let hello: Msg;
      try { hello = JSON.parse(new TextDecoder().decode(buf.subarray(0, nl))); }
      catch { wire.end(new Error("herdr-core answered the framed hello with something that is not JSON")); return; }
      buf = buf.slice(nl + 1);
      if (hello.error) { wire.end(new CoreError(hello.error.message, hello.error.data?.kind ?? "unknown")); return; }
      framed = true;
      h.ready();
    }
    while (!over && buf.length >= 9) {
      const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const ch = v.getUint32(0, true);
      const kind = buf[4]!;
      const len = v.getUint32(5, true);
      if (buf.length < 9 + len) return;
      const payload = buf.slice(9, 9 + len);
      buf = buf.slice(9 + len);
      if (ch === 0 && kind === FRAME_DATA) {
        let reply: Msg;
        try { reply = JSON.parse(new TextDecoder().decode(payload)); }
        catch { wire.end(new Error("herdr-core sent a control frame that is not JSON")); return; }
        h.reply(reply);
      } else if (ch !== 0) {
        h.frame(ch, kind, payload);
      }
    }
  };

  Bun.connect({
    unix: path,
    socket: {
      data(_s, chunk) { feed(new Uint8Array(chunk)); },
      close() { wire.end(new Error(h.closed())); },
      error(s, e) { wire.end(new Error(`herdr-core socket error (${path}): ${e.message}`)); s.end(); },
    },
  }).then((s) => {
    sock = s;
    if (over) { s.end(); return; }
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { framed: true, generation: CORE_GENERATION } }) + "\n");
  }, (e: Error) => wire.end(new Error(`cannot connect to herdr-core at ${path}: ${e.message}`)));

  return wire;
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
   * Watch `terminal` as an observer: never types, never resizes
   * (`observe: true`; the core sizes a terminal by its real viewers only), so
   * the operator's own view in the app is not touched. Its own framed
   * connection, kept open until the returned closer is called.
   *
   * Framed mode (herdr-core `wire.rs`): after the hello's reply LINE, every
   * message is `[channel u32 LE][kind u8][len u32 LE][payload]`. Channel 0
   * carries JSON-RPC; the attach answers with its own channel, which then
   * carries the first paint and the live bytes as DATA, every DATA answered
   * with CREDIT for what was read. With `resize_notifications` the core sends
   * RESIZE (u16 cols, u16 rows) before the first paint and before each
   * replacement paint.
   *
   * Resolves once the attach is accepted. `onClose` fires once, for any end
   * paddock did not ask for; closing via the returned function does not.
   */
  observe(
    terminal: string,
    size: { cols: number; rows: number; history: number },
    h: {
      onData: (bytes: Uint8Array) => void;
      onResize: (cols: number, rows: number) => void;
      onClose: (reason: Error) => void;
    },
  ): Promise<() => void> {
    const path = this.path;
    const timeoutMs = this.timeoutMs;
    return new Promise<() => void>((resolve, reject) => {
      let channel: number | null = null;
      let accepted = false;
      const timer = setTimeout(() => wire.end(new Error(`herdr-core: attach to ${terminal} timed out after ${timeoutMs} ms`)), timeoutMs);

      const wire = framedConnection(path, {
        ready: () => {
          wire.request(1, "terminal.attach", { terminal, observe: true, resize_notifications: true, ...size });
        },
        reply: (reply) => {
          if (reply.id !== 1) return;
          if (reply.error) {
            wire.end(new CoreError(reply.error.message, reply.error.data?.kind ?? "unknown", reply.error.data?.hint));
            return;
          }
          channel = Number(reply.result?.channel);
          wire.channel = channel;
          accepted = true;
          clearTimeout(timer);
          resolve(() => wire.end(null));
        },
        frame: (ch, kind, payload) => {
          if (channel === null || ch !== channel) return;
          if (kind === FRAME_DATA) {
            h.onData(payload);
            wire.credit(payload.length);
          } else if (kind === FRAME_RESIZE && payload.length === 4) {
            const v = new DataView(payload.buffer, payload.byteOffset, 4);
            h.onResize(v.getUint16(0, true), v.getUint16(2, true));
          } else if (kind === FRAME_CLOSE) {
            const why = new TextDecoder().decode(payload);
            wire.end(new Error(`herdr-core ended the view of ${terminal}${why ? `: ${why}` : ""}`));
          }
        },
        closed: () => `herdr-core closed the view of ${terminal}`,
        ended: (reason) => {
          clearTimeout(timer);
          if (reason === null) return; // paddock closed it
          if (accepted) h.onClose(reason);
          else reject(reason);
        },
      });
    });
  }

  /**
   * Type `text` into `terminal` WITHOUT pressing Enter: the one thing no plain
   * request does (`terminal.send` always submits; `terminal.keys` has no key
   * for `à` or `?`). Measured on a Claude Code question dialog
   * (docs/probes/2026-11-09-herdr-core.md, step 7).
   *
   * A typing attach of its own, built so it can never take the terminal's
   * size from the operator's window (herdr-core `viewers.rs`): `observe:
   * false` because an observer's input is dropped; `resumed: true` so the
   * attach has never been "active", and the core sizes a terminal by its most
   * recently active typing viewer; the terminal's own `cols`/`rows`, so even
   * as the only viewer it sets the size the terminal already has; and the
   * bytes as AUTOMATIC_INPUT, because DATA counts as a person typing and makes
   * the attach active. A core whose attach does not take AUTOMATIC_INPUT is
   * refused rather than typed at as a person.
   *
   * Resolves once the bytes are in: the core handles input frames as it reads
   * them, so its answer to a request sent after them on the same connection
   * comes after they were written.
   */
  typeText(terminal: string, text: string, size: { cols: number; rows: number }): Promise<void> {
    const path = this.path;
    const timeoutMs = this.timeoutMs;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => wire.end(new Error(`herdr-core: typing into ${terminal} timed out after ${timeoutMs} ms`)), timeoutMs);

      const wire = framedConnection(path, {
        ready: () => {
          wire.request(1, "terminal.attach", { terminal, observe: false, resumed: true, ...size, history: 0 });
        },
        reply: (reply) => {
          if (reply.error) {
            wire.end(new CoreError(reply.error.message, reply.error.data?.kind ?? "unknown", reply.error.data?.hint));
            return;
          }
          if (reply.id === 1) {
            wire.channel = Number(reply.result?.channel);
            if (reply.result?.automatic_input !== true) {
              wire.end(new Error(`herdr-core: this core's attach does not take automatic input; nothing was typed into ${terminal}`));
              return;
            }
            wire.send(wire.channel, FRAME_AUTOMATIC_INPUT, new TextEncoder().encode(text));
            wire.request(2, "terminal.get", { terminal });
          } else if (reply.id === 2) {
            wire.end(null);
          }
        },
        // The first paint every attach is sent: not read, and not credited,
        // so the core simply stops sending it.
        frame: () => {},
        closed: () => `herdr-core closed the connection while typing into ${terminal}`,
        ended: (reason) => {
          clearTimeout(timer);
          if (reason === null) resolve();
          else reject(reason);
        },
      });
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
