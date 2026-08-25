import { HERDR_PROTOCOL, type HerdrEvent } from "@shared/herdr-api";

// Which side is stale decides the whole message, and getting that wrong is
// expensive: the version this replaced told EVERY mismatch to run `make types`.
// That is right only when herdr is NEWER. Against an OLDER herdr it regenerates
// HERDR_PROTOCOL downwards and shrinks the generated status enums, trading a
// loud startup failure for a silently narrowed contract and empty agent rows —
// so scripts/gen-herdr-types.ts now refuses it and this message no longer
// suggests it in the direction where it does damage.
function mismatchMessage(expected: number, actual: number): string {
  const advice =
    actual < expected
      ? [
          "  your herdr is older than this paddock. The socket answers from the",
          "  RUNNING daemon, not the binary on disk, so upgrading herdr is not",
          "  enough on its own — the daemon has to be replaced too:",
          "    herdr status server     what the running daemon actually speaks",
          "    herdr update --handoff  when herdr itself is out of date",
          "    herdr server stop       when it is current and only the daemon is stale",
        ]
      : [
          "  your herdr is newer than this paddock — `paddock update`. If you are",
          "  working on paddock itself, run `make types` and re-check",
          "  src/server/herdr/adapter.ts for fields the new protocol moved",
        ];
  return [
    "paddock: herdr protocol mismatch",
    `  paddock expects  ${expected}`,
    `  herdr reports    ${actual}`,
    ...advice,
  ].join("\n");
}

export class ProtocolMismatchError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(mismatchMessage(expected, actual));
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
// Structural events — Spaces screen invalidation.
//
// Measured against a live herdr 0.8.2, not guessed: see
// docs/probes/2026-08-25-structural-events.md. All six subscribe dotted and
// deliver underscored, same as pane.agent_detected above but unlike
// pane.agent_status_changed, which stays dotted both ways. Match on the
// top-level `event` field, following the pane.* convention already in this
// file — the probe found the name duplicated at `data.type` too, but `event`
// is what the rest of this module matches on.
// ---------------------------------------------------------------------------

/** Delivered names for structural changes — match incoming events on these. */
export const EVENT_WORKSPACE_CREATED = "workspace_created";
export const EVENT_WORKSPACE_CLOSED = "workspace_closed";
export const EVENT_WORKSPACE_RENAMED = "workspace_renamed";
export const EVENT_TAB_CREATED = "tab_created";
export const EVENT_TAB_CLOSED = "tab_closed";
export const EVENT_TAB_RENAMED = "tab_renamed";

/**
 * Structure only.
 *
 * `workspace.updated` and `workspace.metadata_updated` are deliberately
 * ABSENT: a space's rollup `agent_status` moves on those, so subscribing
 * would turn invalidation into a refetch on every agent state change —
 * strictly worse than having none.
 */
export const STRUCTURAL_SUBSCRIPTIONS: Subscription[] = [
  { type: "workspace.created" }, { type: "workspace.closed" }, { type: "workspace.renamed" },
  { type: "tab.created" }, { type: "tab.closed" }, { type: "tab.renamed" },
];

// ---------------------------------------------------------------------------
// Requests: one connection, one request, one response. herdr hangs up after
// the response, so there is nothing to pool, reuse, or correlate by id.
// ---------------------------------------------------------------------------

/**
 * Ceiling on how long herdr may take to answer, and on how long it may take
 * to acknowledge an events.subscribe.
 *
 * Not optional politeness. Without it, a herdr that ACCEPTS a connection and
 * then never answers wedges everything downstream: reconcile() hangs, so
 * runRefreshLoop() never resolves, so `refreshLoop` stays non-null and every
 * later refresh() returns that same hung promise — including the reconnect
 * keeper's, which then awaits it forever instead of retrying. Meanwhile the
 * 30s healing timer leaks one hung socket and one dangling promise per tick.
 * A dead herdr must fail, loudly and boundedly, not hang.
 */
export const HERDR_TIMEOUT_MS = 10_000;

export function request<T>(
  path: string,
  method: string,
  params: object = {},
  timeoutMs: number = HERDR_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let live: { terminate(): void } | null = null;

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`herdr ${method} timed out after ${timeoutMs}ms`)));
      // terminate(), not end(): nothing is coming back on this connection, and
      // a half-open socket per timed-out request is one leaked fd per healing
      // reconcile, forever.
      live?.terminate();
      live = null;
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          live = socket;
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
          live = null;
          finish(() => reject(new Error(`herdr closed the connection before answering ${method}`)));
        },
        error(_socket, err) {
          live = null;
          finish(() => reject(err));
        },
      },
    }).catch((err) => finish(() => reject(err)));
  });
}

/** What the live herdr's protocol means for this paddock. */
export type ProtocolCheck =
  | { kind: "match" }
  | { kind: "newer"; herdr: number; paddock: number };

/**
 * DIRECTIONAL, and that asymmetry is the whole point.
 *
 * An OLDER herdr throws: it genuinely lacks what this paddock reads, and
 * `mismatchMessage` already says what to do about it.
 *
 * A NEWER herdr is REPORTED, not fatal. `scripts/protocol-guard.ts` has always
 * encoded this asymmetry for `make types` — it refuses a downgrade and allows an
 * upgrade — but this function used strict inequality and treated both directions
 * as equally fatal. Measured cost of that: herdr 0.8.0 → 0.8.2 moved the
 * protocol 19 → 20 and changed nothing paddock reads (the status enum was
 * byte-identical), yet paddock refused to start at all. An integer that carried
 * no consequence took the whole dashboard down.
 *
 * A version number was never the real contract. What breaks paddock is a FIELD
 * going away, so `checkAgentShape` verifies that against live `agent.list` data
 * and is the safety this relaxation trades for. Do not reintroduce equality
 * here without deleting that check too, or you get the brittleness back with
 * none of the protection.
 */
export async function checkProtocol(path: string): Promise<ProtocolCheck> {
  const pong = await request<{ protocol: number }>(path, "ping", {});

  // Guarded BEFORE the comparisons, because two ordered comparisons have a hole
  // that `!==` did not: `undefined < N` and `undefined > N` are both false, so
  // an absent or non-numeric protocol fell straight through to "match" and
  // paddock started as if it had verified something. `request` does no
  // validation — it resolves `frame.result` as-is — so a renamed field, a
  // different daemon answering on this socket path, or any unexpected result
  // shape lands here. Reported as a mismatch against NaN so the message still
  // shows what herdr actually said.
  if (typeof pong.protocol !== "number" || !Number.isFinite(pong.protocol)) {
    throw new ProtocolMismatchError(HERDR_PROTOCOL, pong.protocol as unknown as number);
  }

  if (pong.protocol < HERDR_PROTOCOL) {
    throw new ProtocolMismatchError(HERDR_PROTOCOL, pong.protocol);
  }
  if (pong.protocol > HERDR_PROTOCOL) {
    return { kind: "newer", herdr: pong.protocol, paddock: HERDR_PROTOCOL };
  }
  return { kind: "match" };
}

// ---------------------------------------------------------------------------
// The event stream: the one connection that stays open. Nothing else may be
// sent on it — herdr closes it if anything is.
// ---------------------------------------------------------------------------

export interface HerdrStreamOptions {
  path: string;
  onEvent: (e: HerdrEvent) => void;
  onStateChange?: (connected: boolean) => void;
  /** Ceiling on the events.subscribe acknowledgement. Injectable for tests. */
  ackTimeoutMs?: number;
}

type BunSocket = Awaited<ReturnType<typeof Bun.connect>>;

export class HerdrStream {
  private socket: BunSocket | null = null;
  private buffer = "";
  private wantOpen = false;
  // Set when this open()'s close handler has already reported a disconnect,
  // so a failure that lands in both places is reported once, not twice.
  private downReported = false;
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
   *
   * If it fails AFTER tearing down a live socket, it reports a disconnect:
   * there genuinely is no stream any more, and nobody asked for that. That is
   * the one path that used to dead-end — a lifecycle event triggers refresh(),
   * reconcile() succeeds, herdr dies, the old socket is torn down deliberately
   * (so it reports nothing) and the replacement never connects (so there is no
   * close handler to report either). No stream, no keeper armed, and
   * `/api/health` still claiming herdrConnected. A routine reopen that
   * SUCCEEDS still reports nothing but the final `true`.
   */
  async open(subs: Subscription[]): Promise<void> {
    const replacingLiveStream = this.socket !== null;
    this.close();
    this.wantOpen = true;
    this.downReported = false;
    this.buffer = "";

    // `handle` lets each socket's handlers identify THEMSELVES once the
    // connect resolves. The socket object does not exist yet at the point the
    // handlers are written, so the box is filled in below.
    const handle: { socket: BunSocket | null } = { socket: null };
    /**
     * Only the socket currently installed on this stream may mutate stream
     * state. Previously the handlers just assumed they were current, which
     * held only because Bun invokes `close` synchronously inside `end()` — an
     * invariant defended by a comment rather than by code. If an older
     * socket's close ever landed after a newer one was installed, it would
     * null out the live socket and reject the new open()'s pending ack.
     */
    const isCurrent = () => handle.socket === null || this.socket === handle.socket;

    try {
      const socket = await Bun.connect({
        unix: this.opts.path,
        socket: {
          data: (_s, chunk) => this.onData(chunk.toString()),
          close: () => {
            if (!isCurrent()) return;
            this.socket = null;
            // wantOpen is false here precisely when THIS teardown was
            // requested: close() (called directly, or from the top of this
            // very open() when replacing an existing stream for a routine
            // resubscribe) always flips it to false BEFORE calling
            // socket.end(). Only a drop that nobody asked for counts as a
            // real disconnect: reporting `false` on every deliberate
            // teardown-for-reopen would fire on every routine agent
            // start/exit, burying the one signal a genuine incident needs to
            // stand out against (and would spuriously trigger the reconnect
            // keeper on every such routine event, not just a real one).
            if (this.wantOpen) {
              console.error("herdr: event stream closed unexpectedly");
              this.downReported = true;
              this.opts.onStateChange?.(false);
            }
            // If the socket closed before the subscribe ack arrived, settle
            // open()'s promise instead of leaving the caller's `await` hanging
            // forever with no error and no stack.
            this.settleAck(new Error("herdr: socket closed before events.subscribe was acknowledged"));
          },
          error: (_s, err) => {
            if (!isCurrent()) return;
            console.error("herdr: event stream error", err);
            this.settleAck(
              new Error(`herdr: socket errored before events.subscribe was acknowledged: ${err}`),
            );
          },
        },
      });

      handle.socket = socket;
      this.socket = socket;

      await this.awaitAck(socket, subs);
    } catch (err) {
      // The replacement stream never came up. Drop whatever half-open socket
      // is left — a subscribe herdr REJECTED leaves a connection that is open
      // but carries no subscription, which is not a stream — without letting
      // its close handler report a second time for the same failure.
      this.wantOpen = false;
      this.socket?.end();
      this.socket = null;
      if (replacingLiveStream && !this.downReported) {
        this.downReported = true;
        console.error("herdr: could not re-open the event stream", err);
        this.opts.onStateChange?.(false);
      }
      throw err;
    }

    this.opts.onStateChange?.(true);
  }

  /**
   * Wait for the events.subscribe acknowledgement, bounded.
   *
   * herdr accepting the connection and then never acknowledging would
   * otherwise hang open() forever, and with it the supervisor's refresh loop
   * and the keeper awaiting that same promise. See HERDR_TIMEOUT_MS.
   */
  private awaitAck(socket: BunSocket, subs: Subscription[]): Promise<void> {
    const timeoutMs = this.opts.ackTimeoutMs ?? HERDR_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleAck(new Error(`herdr events.subscribe timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingAck = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      socket.write(JSON.stringify({
        id: "paddock-sub",
        method: "events.subscribe",
        params: { subscriptions: subs },
      }) + "\n");
    });
  }

  /** Reject a still-pending ack exactly once. */
  private settleAck(err: Error): void {
    const ack = this.pendingAck;
    this.pendingAck = null;
    ack?.reject(err);
  }

  close(): void {
    this.wantOpen = false;
    // Settle a still-pending open() rather than leaving it to hang forever:
    // close() can race an in-flight open() (e.g. open() called again before
    // the first one's ack arrived).
    this.settleAck(new Error("herdr: stream closed before events.subscribe was acknowledged"));
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
