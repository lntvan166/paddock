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
