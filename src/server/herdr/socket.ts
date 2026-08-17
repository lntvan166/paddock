import { HERDR_PROTOCOL, type HerdrEvent } from "@shared/herdr-api";

export class ProtocolMismatchError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(
      `herdr protocol mismatch: paddock expects ${expected}, herdr reports ${actual}. ` +
        `Run \`make types\` and re-check src/server/herdr/adapter.ts before continuing.`,
    );
    this.name = "ProtocolMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Wire names.
//
// The name you SUBSCRIBE with is not always the name herdr DELIVERS. The three
// SubscriptionEventKind types keep their dotted names; every other subscribable
// type is delivered with underscores. Matching on the subscribe name for those
// silently never fires, so both spellings are pinned here as named constants
// rather than written inline at call sites.
// ---------------------------------------------------------------------------

/** Delivered names — match incoming events against these. */
export const EVENT_STATUS_CHANGED = "pane.agent_status_changed"; // dotted
export const EVENT_AGENT_DETECTED = "pane_agent_detected";       // underscored
export const EVENT_PANE_CLOSED = "pane_closed";                  // underscored
export const EVENT_PANE_EXITED = "pane_exited";                  // underscored

/** Subscribe names — send these in events.subscribe. */
const SUB_STATUS_CHANGED = "pane.agent_status_changed";
const SUB_AGENT_DETECTED = "pane.agent_detected";
const SUB_PANE_CLOSED = "pane.closed";
const SUB_PANE_EXITED = "pane.exited";

export interface Subscription {
  type: string;
  pane_id?: string;
}

/** pane.agent_status_changed has no global form — each pane must be named. */
export function statusSubscriptions(paneIds: string[]): Subscription[] {
  return paneIds.map((pane_id) => ({ type: SUB_STATUS_CHANGED, pane_id }));
}

/** These take no pane_id. They are how paddock learns the pane set changed. */
export const GLOBAL_SUBSCRIPTIONS: Subscription[] = [
  { type: SUB_AGENT_DETECTED },
  { type: SUB_PANE_CLOSED },
  { type: SUB_PANE_EXITED },
];

// ---------------------------------------------------------------------------
// Requests: one connection, one request, one response. herdr hangs up after
// the response, so there is nothing to pool, reuse, or correlate by id.
// ---------------------------------------------------------------------------

export function request<T>(path: string, method: string, params: object = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write(JSON.stringify({ id: "paddock", method, params }) + "\n");
        },
        data(socket, chunk) {
          buffer += chunk.toString();
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          const line = buffer.slice(0, newline);
          // Settle BEFORE ending the socket: Bun's socket.end() invokes the
          // `close` handler synchronously, before returning. If we called
          // end() first, that close handler would see `settled === false`
          // and reject with "closed before answering" — a spurious failure
          // racing against the resolve/reject below.
          let frame: any;
          try {
            frame = JSON.parse(line);
          } catch (err) {
            finish(() => reject(new Error(`herdr sent an unparseable frame for ${method}: ${err}`)));
            socket.end();
            return;
          }
          if (frame.error) {
            const { code, message } = frame.error;
            finish(() => reject(new Error(`herdr ${method} failed [${code}]: ${message}`)));
            socket.end();
            return;
          }
          finish(() => resolve(frame.result as T));
          socket.end();
        },
        close() {
          finish(() => reject(new Error(`herdr closed the connection before answering ${method}`)));
        },
        error(_socket, err) {
          finish(() => reject(err));
        },
      },
    }).catch((err) => finish(() => reject(err)));
  });
}

export async function checkProtocol(path: string): Promise<void> {
  const pong = await request<{ protocol: number }>(path, "ping", {});
  if (pong.protocol !== HERDR_PROTOCOL) {
    throw new ProtocolMismatchError(HERDR_PROTOCOL, pong.protocol);
  }
}

// ---------------------------------------------------------------------------
// The event stream: the one connection that stays open. Nothing else may be
// sent on it — herdr closes it if anything is.
// ---------------------------------------------------------------------------

export interface HerdrStreamOptions {
  path: string;
  onEvent: (e: HerdrEvent) => void;
  onStateChange?: (connected: boolean) => void;
}

export class HerdrStream {
  private socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  private buffer = "";
  private wantOpen = false;
  // Resolved/rejected when the events.subscribe acknowledgement frame
  // arrives. `open()` awaits this so callers only see it resolve once the
  // subscription genuinely started — see the comment in `open()` below for
  // why that wait is load-bearing, not decorative.
  private pendingAck: { resolve: () => void; reject: (err: Error) => void } | null = null;

  constructor(private readonly opts: HerdrStreamOptions) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  /**
   * Open a stream carrying `subs`. Any existing stream is closed first: a
   * subscription set cannot be extended after the fact, so changing it means
   * replacing the connection.
   *
   * Resolves only once herdr has acknowledged the `events.subscribe` call,
   * not merely once the TCP/unix connection is established. A write() is
   * asynchronous relative to the connect promise: resolving right after
   * `socket.write()` lets callers observe an "open" stream before herdr has
   * even seen the subscribe request, which is both a race in tests and a
   * real gap in production (a caller could reasonably assume "open resolved"
   * implies "subscribed").
   */
  async open(subs: Subscription[]): Promise<void> {
    this.close();
    this.wantOpen = true;
    this.buffer = "";

    const socket = await Bun.connect({
      unix: this.opts.path,
      socket: {
        data: (_s, chunk) => this.onData(chunk.toString()),
        close: () => {
          this.socket = null;
          this.opts.onStateChange?.(false);
          if (this.wantOpen) console.error("herdr: event stream closed unexpectedly");
        },
        error: (_s, err) => console.error("herdr: event stream error", err),
      },
    });

    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      this.pendingAck = { resolve, reject };
      socket.write(JSON.stringify({
        id: "paddock-sub",
        method: "events.subscribe",
        params: { subscriptions: subs },
      }) + "\n");
    });

    this.opts.onStateChange?.(true);
  }

  close(): void {
    this.wantOpen = false;
    // Settle a still-pending open() rather than leaving it to hang forever:
    // close() can race an in-flight open() (e.g. open() called again before
    // the first one's ack arrived).
    this.pendingAck?.reject(new Error("herdr: stream closed before events.subscribe was acknowledged"));
    this.pendingAck = null;
    this.socket?.end();
    this.socket = null;
  }

  // A frame may arrive split across chunks, or several frames in one chunk.
  // Keep the trailing partial line in the buffer.
  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        console.error("herdr: unparseable frame", { bytes: line.length, err });
        continue;
      }
      // The subscribe acknowledgement carries an id; events do not.
      if (typeof frame.id === "string") {
        const ack = this.pendingAck;
        this.pendingAck = null;
        if (frame.error) {
          const { code, message } = frame.error;
          const err = new Error(`herdr events.subscribe failed [${code}]: ${message}`);
          console.error("herdr: events.subscribe was rejected", frame.error);
          ack?.reject(err);
        } else {
          ack?.resolve();
        }
        continue;
      }
      if (typeof frame.event === "string") this.opts.onEvent(frame as HerdrEvent);
      else console.error("herdr: frame with neither id nor event", frame);
    }
  }
}
