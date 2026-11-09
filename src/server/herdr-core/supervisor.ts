/**
 * Keeps the store's `core` agents current from the herdr-core event stream.
 *
 * The core is optional: no socket, a refused connection, a wrong protocol
 * generation or a dropped stream all end the same way. Core agents leave the
 * store (they would otherwise sit there looking live), the reason is logged
 * ONCE at INFO per transition, and a timer tries again. paddock keeps running
 * and the terminal-herdr path is never touched.
 */
import type { CoreEvent, CoreSubscribeResult, CoreTerminal, CoreUnknownEvent } from "@shared/herdr-core-api";
import { coreId } from "@shared/origin";
import type { Agent, HealthBody } from "@shared/types";
import type { AgentStore, Delta } from "@server/state/store";
import { applyCoreEvent, toCoreAgent } from "./adapter";
import type { CoreClient } from "./socket";

/** The slice of CoreClient the supervisor uses, so a test can fake it. */
export type CoreClientLike = Pick<CoreClient, "hello" | "request" | "subscribe" | "close">;

export interface CoreSupervisorOptions {
  /** A client for the core's socket, or null when none exists right now. */
  connect: () => CoreClientLike | null;
  store: AgentStore;
  onDelta: (d: Delta) => void;
  now?: () => number;
  retryMs?: number;
}

type CoreHealth = HealthBody["core"];

export class CoreSupervisor {
  private readonly now: () => number;
  private readonly retryMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private client: CoreClientLike | null = null;
  private closeStream: (() => void) | null = null;
  private stopped = true;
  /** Bumped per attempt; a late callback from an older attempt is ignored. */
  private attemptId = 0;
  private up = false;
  /** Whether the current down state has already been logged. */
  private downLogged = false;
  private seq = -1;
  /** Terminals as last seen, so an event can turn a non-agent into an agent. */
  private records = new Map<string, CoreTerminal>();
  private eventAt: number | null = null;
  private generation: number | null = null;
  private version: string | null = null;
  private detail: string | null = null;

  constructor(private readonly o: CoreSupervisorOptions) {
    this.now = o.now ?? Date.now;
    this.retryMs = o.retryMs ?? 5_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.attempt();
  }

  stop(): void {
    this.stopped = true;
    this.attemptId++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.closeStream?.();
    this.closeStream = null;
    this.client?.close();
    this.client = null;
    this.up = false;
    this.publish(this.o.store.removeOrigin("core"));
  }

  health(): CoreHealth {
    return {
      connected: this.up,
      lastEventAt: this.eventAt,
      generation: this.generation,
      version: this.version,
      detail: this.up ? null : this.detail,
    };
  }

  /**
   * The client actions should use, or null while the core is not up. Only
   * after the snapshot: before it, the store holds no core agents, so no
   * route could have validated a core id against it anyway.
   */
  connection(): CoreClientLike | null {
    return this.up ? this.client : null;
  }

  private publish(d: Delta): void {
    if (d.upserted.length || d.removedIds.length) this.o.onDelta(d);
  }

  private async attempt(): Promise<void> {
    const id = ++this.attemptId;
    let client: CoreClientLike | null = null;
    try {
      client = this.o.connect();
      if (!client) throw new Error("no herdr-core socket found");
      this.client = client;
      const hello = await client.hello();
      if (id !== this.attemptId) { client.close(); return; }
      this.generation = hello.generation;
      // hello carries no version on a live core; server.status does. A
      // failure here costs the version only, so it is logged, not fatal.
      try {
        const st = await client.request<{ version?: string }>("server.status", {});
        this.version = st.version ?? null;
      } catch (e) {
        this.version = null;
        console.info(`herdr-core: version unknown (server.status failed: ${(e as Error).message})`);
      }
      if (id !== this.attemptId) { client.close(); return; }
      this.closeStream = await client.subscribe(
        (snap) => { if (id === this.attemptId) this.onSnapshot(snap); },
        (e) => { if (id === this.attemptId) this.onEvent(e); },
        (reason) => { if (id === this.attemptId) this.down(reason.message); },
      );
      if (id !== this.attemptId) this.closeStream();
    } catch (e) {
      if (id !== this.attemptId) return;
      client?.close();
      this.down((e as Error).message);
    }
  }

  /** The core is unavailable: drop its agents, say so once, retry later. */
  private down(reason: string): void {
    if (this.stopped) return;
    this.closeStream = null;
    this.client?.close();
    this.client = null;
    this.attemptId++;
    this.detail = reason;
    this.up = false;
    this.records.clear();
    this.seq = -1;
    this.publish(this.o.store.removeOrigin("core"));
    if (!this.downLogged) {
      console.info(`herdr-core: not running (${reason})`);
      this.downLogged = true;
    }
    this.timer = setTimeout(() => { this.timer = null; void this.attempt(); }, this.retryMs);
  }

  private onSnapshot(s: CoreSubscribeResult): void {
    this.seq = s.seq;
    this.eventAt = this.now();
    this.records = new Map(s.terminals.map((t) => [t.address, t]));
    const agents: Agent[] = [];
    for (const t of s.terminals) {
      const a = toCoreAgent(t, this.o.store.hostId);
      if (a) agents.push(a);
    }
    this.publish(this.o.store.replaceAll(agents, this.now(), "core"));
    if (!this.up) {
      this.up = true;
      this.detail = null;
      this.downLogged = false;
      console.info(`herdr-core: connected · ${agents.length} agents`);
    }
  }

  private onEvent(e: CoreEvent | CoreUnknownEvent): void {
    if (e.seq <= this.seq) return; // already covered by the snapshot
    this.seq = e.seq;
    this.eventAt = this.now();
    const term = e.terminal;
    if (term === undefined) return; // a `doc` event: not about an agent
    const id = coreId(term);
    const store = this.o.store;
    const prev = store.snapshot().find((a) => a.agentId === id) ?? null;
    const ev = e as CoreEvent;

    // Keep a record per terminal so an event can promote a non-agent.
    let record = this.records.get(term);
    if (ev.type === "created" || ev.type === "restarted") record = ev.data;
    else if (ev.type === "labels" && ev.data.record) record = ev.data.record;
    else if (ev.type === "status" && record) record = { ...record, status: ev.data.status, status_ms: this.now() };
    if (ev.type === "removed") this.records.delete(term);
    else if (record) this.records.set(term, record);

    const next = applyCoreEvent(prev, ev, record, { hostId: store.hostId, now: this.now() });
    if (!next) {
      const d = store.remove(id);
      if (d) this.o.onDelta(d);
      return;
    }
    if (prev) {
      store.applyEvent(id, () => next);
      this.o.onDelta({ upserted: [next], removedIds: [] });
    } else {
      // New to the store: replaceAll is the only insert, and only touches `core`.
      const all = [...store.snapshot().filter((a) => a.origin === "core"), next];
      this.publish(store.replaceAll(all, this.now(), "core"));
    }
  }
}
