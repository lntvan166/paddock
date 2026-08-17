import type { Agent, ServerMessage } from "@shared/types";

export interface HubClient {
  send(data: string): void;
}

export interface HubOptions {
  /** Window for merging a burst of changes into one frame. */
  coalesceMs?: number;
  /**
   * Liveness interval. Comfortably inside the client's 60s staleness
   * threshold, and injectable so tests do not sleep for 20 seconds.
   */
  heartbeatMs?: number;
  now?: () => number;
}

/**
 * Browser fan-out. Knows nothing about herdr — it only forwards agents.
 *
 * Bursts are coalesced: an agent flipping working -> idle -> working within the
 * window produces one frame carrying its final value, not three.
 */
export class Hub {
  private readonly clients = new Set<HubClient>();
  private readonly pendingUpserts = new Map<string, Agent>();
  private readonly pendingRemovals = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly coalesceMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;

  constructor(opts: HubOptions = {}) {
    this.coalesceMs = opts.coalesceMs ?? 100;
    this.heartbeatMs = opts.heartbeatMs ?? 20_000;
    this.now = opts.now ?? Date.now;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get heartbeatIntervalMs(): number {
    return this.heartbeatMs;
  }

  /**
   * Start proving the link is alive.
   *
   * Nothing else on the server sends anything on a quiet system: flush()
   * returns early with nothing pending, and the supervisor emits a delta only
   * when a reconcile actually changed something. Idle agents overnight — the
   * primary use case — therefore produce exactly zero traffic, and without
   * this the UI would show the amber staleness banner and dim to 0.55 opacity
   * while the link was perfectly healthy.
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** One liveness frame to every connected browser. Carries no agent data. */
  sendHeartbeat(): void {
    const msg: ServerMessage = { type: "heartbeat", serverTime: this.now() };
    for (const client of [...this.clients]) this.sendTo(client, msg);
  }

  add(client: HubClient): void {
    this.clients.add(client);
  }

  remove(client: HubClient): void {
    this.clients.delete(client);
  }

  sendSnapshot(client: HubClient, hostId: string, agents: Agent[]): void {
    this.sendTo(client, { type: "snapshot", hostId, agents, serverTime: this.now() });
  }

  queue(delta: { upserted: Agent[]; removedIds: string[] }): void {
    for (const a of delta.upserted) {
      this.pendingRemovals.delete(a.agentId);
      this.pendingUpserts.set(a.agentId, a);
    }
    for (const id of delta.removedIds) {
      this.pendingUpserts.delete(id);
      this.pendingRemovals.add(id);
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.coalesceMs);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingUpserts.size === 0 && this.pendingRemovals.size === 0) return;

    const msg: ServerMessage = {
      type: "delta",
      upserted: [...this.pendingUpserts.values()],
      removedIds: [...this.pendingRemovals],
      serverTime: this.now(),
    };
    this.pendingUpserts.clear();
    this.pendingRemovals.clear();
    for (const client of this.clients) this.sendTo(client, msg);
  }

  private sendTo(client: HubClient, msg: ServerMessage): void {
    try {
      client.send(JSON.stringify(msg));
    } catch (err) {
      console.error("hub: send failed, dropping client", err);
      this.clients.delete(client);
    }
  }
}
