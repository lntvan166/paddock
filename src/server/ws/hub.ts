import type { Agent, ServerMessage } from "@shared/types";

export interface HubClient {
  send(data: string): void;
}

export interface HubOptions {
  /** Window for merging a burst of changes into one frame. */
  coalesceMs?: number;
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
  private readonly coalesceMs: number;
  private readonly now: () => number;

  constructor(opts: HubOptions = {}) {
    this.coalesceMs = opts.coalesceMs ?? 100;
    this.now = opts.now ?? Date.now;
  }

  get clientCount(): number {
    return this.clients.size;
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
