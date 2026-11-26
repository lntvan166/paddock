import type { AgentState, ServerMessage } from "@shared/types";
import { diffScreens, digestOf } from "@shared/screen";

/**
 * Pushes an open terminal's screen over the WebSocket instead of having the
 * browser poll `POST /api/agents/:id/output` for it.
 *
 * WHO gets a screen is already known: every client says which agent it is
 * showing in its `viewing` frame (presence), and a hidden page says none. So
 * no new client message exists and nothing on the socket can ask for
 * anything — a screen is pushed only to a client that is already showing that
 * agent, which the `/output` route would hand it anyway.
 *
 * WHEN is the backend's business: `watch` is given only where the backend can
 * say its screen moved (today, herdr-core agents, whose live mirror is fed by
 * an observer stream). Where it returns null — terminal herdr — nothing is
 * pushed and the browser keeps polling, exactly as before.
 *
 * WHAT is a patch against the screen pushed before it (`base`), the same
 * patch format the route sends, so the browser applies both with one piece of
 * code. `base` is this agent's last PUSHED screen, one history for every
 * viewer, never moved by an HTTP read: two devices on one agent would
 * otherwise each move the other's base on every read. A browser holding a
 * different screen (it read over HTTP in between) repeats its `viewing`
 * frame with `resync`, which is answered with the last pushed screen whole, to that
 * client only, from memory: one frame, no read, and it is in step again.
 *
 * Reads are throttled to one per `minMs` per agent, trailing edge kept, so a
 * burst of output is at most four frames a second at the default and its last
 * state always arrives. A failing read backs off and is said once.
 */

export interface StreamClient {
  send(data: string): void;
}

export interface ScreenStreamDeps {
  /** The agent if the store holds it (so a hidden or unknown id streams nothing). */
  agent: (agentId: string) => { state: AgentState } | null;
  /** Subscribe to "this agent's screen may have moved"; null when the backend cannot say. */
  watch: (agentId: string, onChange: () => void) => (() => void) | null;
  /** The same read `POST /api/agents/:id/output` makes for a visible screen. */
  read: (agentId: string, state: AgentState) => Promise<{ lines: string[]; source: string }>;
  minMs?: number;
  /** After a failed read, wait this long before the next. */
  retryMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface Stream {
  agentId: string;
  clients: Set<StreamClient>;
  unwatch: () => void;
  last: { digest: string; lines: string[]; source: string } | null;
  timer: ReturnType<typeof setTimeout> | null;
  reading: boolean;
  /** A change arrived while a read was in flight: read again after it. */
  again: boolean;
  lastReadAt: number;
  /** Reason of the failure last said, so a repeating one is said once. */
  failing: string | null;
}

export class ScreenStream {
  private readonly streams = new Map<string, Stream>();
  private readonly viewing = new Map<StreamClient, string>();
  private readonly minMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly d: ScreenStreamDeps) {
    this.minMs = d.minMs ?? 250;
    this.retryMs = d.retryMs ?? 5_000;
    this.now = d.now ?? Date.now;
    this.log = d.log ?? console.info;
  }

  /** What `client` is showing now (null: nothing, or hidden). */
  view(client: StreamClient, agentId: string | null, resync = false): void {
    const was = this.viewing.get(client) ?? null;
    if (was === agentId) {
      // The same pane again: a heartbeat's repeat, which changes nothing, or
      // a client out of step asking for the screen whole.
      const s = agentId === null || !resync ? undefined : this.streams.get(agentId);
      if (s) this.resync(client, s);
      return;
    }
    if (was !== null) this.leave(client, was);
    if (agentId === null) { this.viewing.delete(client); return; }
    this.viewing.set(client, agentId);

    let s = this.streams.get(agentId);
    if (!s) {
      if (!this.d.agent(agentId)) return;
      const created: Stream = {
        agentId, clients: new Set(), unwatch: () => {}, last: null, timer: null,
        reading: false, again: false, lastReadAt: 0, failing: null,
      };
      const unwatch = this.d.watch(agentId, () => this.changed(created));
      if (!unwatch) return; // this backend cannot push; the browser polls
      created.unwatch = unwatch;
      s = created;
      this.streams.set(agentId, s);
    }
    s.clients.add(client);
    // A first frame at once: a new stream reads (which also opens the mirror,
    // so changes start arriving); a joiner gets the last screen whole.
    this.resync(client, s);
  }

  private resync(client: StreamClient, s: Stream): void {
    if (!s.last) { this.changed(s); return; }
    client.send(JSON.stringify(this.frame(s.agentId, null, [], s.last.lines, s.last.source)));
  }

  private frame(agentId: string, base: string | null, prev: string[], lines: string[], source: string): ServerMessage {
    return { type: "screen", agentId, base, patch: diffScreens(prev, lines), source };
  }

  /** The connection closed. */
  drop(client: StreamClient): void {
    const was = this.viewing.get(client);
    this.viewing.delete(client);
    if (was !== undefined) this.leave(client, was);
  }

  /** How many agents are being pushed right now (for tests and health). */
  size(): number {
    return this.streams.size;
  }

  close(): void {
    for (const s of [...this.streams.values()]) this.end(s);
    this.viewing.clear();
  }

  private leave(client: StreamClient, agentId: string): void {
    const s = this.streams.get(agentId);
    if (!s) return;
    s.clients.delete(client);
    if (s.clients.size === 0) this.end(s);
  }

  private end(s: Stream): void {
    if (this.streams.get(s.agentId) === s) this.streams.delete(s.agentId);
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.unwatch();
  }

  private live(s: Stream): boolean {
    return this.streams.get(s.agentId) === s;
  }

  private changed(s: Stream): void {
    if (!this.live(s)) return;
    if (s.reading) { s.again = true; return; }
    if (s.timer) return; // already scheduled; it will read the latest
    const wait = Math.max(0, s.lastReadAt + (s.failing ? this.retryMs : this.minMs) - this.now());
    s.timer = setTimeout(() => { s.timer = null; void this.push(s); }, wait);
  }

  private async push(s: Stream): Promise<void> {
    if (!this.live(s)) return;
    const agent = this.d.agent(s.agentId);
    if (!agent) { this.end(s); return; } // gone from the store
    s.reading = true;
    s.again = false;
    s.lastReadAt = this.now();
    try {
      const out = await this.d.read(s.agentId, agent.state);
      if (!this.live(s)) return;
      if (s.failing) {
        this.log(`screen: pushing ${s.agentId} again`);
        s.failing = null;
      }
      const digest = digestOf(out.lines);
      if (s.last?.digest === digest) return;
      const msg = this.frame(s.agentId, s.last?.digest ?? null, s.last?.lines ?? [], out.lines, out.source);
      s.last = { digest, lines: out.lines, source: out.source };
      const data = JSON.stringify(msg);
      for (const c of s.clients) c.send(data);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (s.failing !== why) {
        this.log(`screen: could not push ${s.agentId} (${why}); its viewers poll meanwhile`);
        s.failing = why;
      }
      // Tried again later, not at once: a mirror that cannot attach retires,
      // which reports a change, which would otherwise read in a tight loop.
      s.again = true;
    } finally {
      s.reading = false;
      if (s.again && this.live(s)) this.changed(s);
    }
  }
}
