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
import type { Agent, HealthBody, MachineScope } from "@shared/types";
import type { AgentStore, Delta } from "@server/state/store";
import { applyCoreEvent, coreJournalSession, inScope, toCoreAgent, toHarness } from "./adapter";
import type { HerdrAgentSession } from "@shared/herdr-api";
import type { CoreClient } from "./socket";

/** The slice of CoreClient the supervisor uses, so a test can fake it. */
export type CoreClientLike = Pick<CoreClient, "hello" | "request" | "subscribe" | "close">
  // Named, not left to the runtime object: the actions put held calls on a
  // connection of their own through it, and a wrapper that dropped it would
  // quietly put them back on the shared one.
  & Partial<Pick<CoreClient, "requestAlone" | "observe" | "typeText">>;

export interface CoreSupervisorOptions {
  /** A client for the core's socket, or null when none exists right now. */
  connect: () => CoreClientLike | null;
  store: AgentStore;
  onDelta: (d: Delta) => void;
  now?: () => number;
  retryMs?: number;
  /**
   * Which machines' terminals become agents (see `MachineScope`). Read on
   * every snapshot and event; after it changes, call `rescope()`. A terminal
   * out of scope never reaches the store, so nothing downstream of it — the
   * Agents screen, push and Telegram, the MCP tools, every action route that
   * looks an id up in the store — can see or reach it. Defaults to `all`.
   */
  scope?: () => MachineScope;
}

type CoreHealth = HealthBody["core"];

export class CoreSupervisor {
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly scope: () => MachineScope;
  /** The scope the store's core agents were last built with. */
  private applied: MachineScope;
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
  /** Each document's version as its last `doc` event said. */
  private docVersions = new Map<string, number>();
  private eventAt: number | null = null;
  private generation: number | null = null;
  private version: string | null = null;
  private detail: string | null = null;
  /** Resolved when the first attempt has settled, up or down. */
  private settleFirst!: () => void;
  private readonly first = new Promise<void>((r) => { this.settleFirst = r; });

  constructor(private readonly o: CoreSupervisorOptions) {
    this.now = o.now ?? Date.now;
    this.retryMs = o.retryMs ?? 5_000;
    this.scope = o.scope ?? (() => "all");
    this.applied = this.scope();
  }

  /**
   * Re-apply the machine scope after it changed. Rebuilt from the terminal
   * records the supervisor keeps (every terminal, in scope or not), so it
   * needs no reconnect and the store changes in one delta. A no-op when the
   * scope did not change or the core is not up (the next snapshot applies it).
   */
  rescope(): void {
    const scope = this.scope();
    if (scope === this.applied) return;
    this.applied = scope;
    console.info(`herdr-core: listing ${scope === "local" ? "this machine's agents only" : "agents on every machine"}`);
    if (!this.up) return;
    this.publish(this.o.store.replaceAll(this.agentsFrom([...this.records.values()]), this.now(), "core"));
  }

  /** The agents among `terms` that the current scope shows. */
  private agentsFrom(terms: CoreTerminal[]): Agent[] {
    const scope = this.scope();
    const prev = new Map(this.o.store.snapshot().filter((a) => a.origin === "core").map((a) => [a.agentId, a]));
    const agents: Agent[] = [];
    for (const t of terms) {
      if (!inScope(scope, t.address)) continue;
      const a = toCoreAgent(t, this.o.store.hostId);
      if (!a) continue;
      // An agent already in the store keeps what the store knows of it.
      const had = prev.get(a.agentId);
      agents.push(had ?? a);
    }
    return agents;
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
    this.settleFirst();
  }

  /**
   * Resolves once the first connection attempt has settled: the snapshot
   * landed (connected) or the attempt failed (down). Boot waits on this to
   * learn whether a core is there before deciding it can run without terminal
   * herdr; it never rejects.
   */
  firstAttempt(): Promise<void> {
    return this.first;
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
  /**
   * Every terminal, as the subscription snapshot gave them and every event
   * since kept them: a `terminal.list` without asking. Null while not up.
   * `terminal.list` lists every added machine's terminals too, over its
   * line; this costs nothing.
   */
  terminals(): CoreTerminal[] | null {
    return this.up ? [...this.records.values()] : null;
  }

  /** The journal session of a core agent (`coreJournalSession`), if any. */
  sessionFor(agentId: string): HerdrAgentSession | null {
    const raw = agentId.startsWith("hc.") ? agentId.slice(3) : null;
    const t = raw === null ? undefined : this.records.get(raw);
    if (!t || !t.status) return null;
    return coreJournalSession(t.address, t.labels, toHarness(t.status.app));
  }

  /** A document's version as its last `doc` event said; null before one. */
  docVersion(name: string): number | null {
    return this.docVersions.get(name) ?? null;
  }

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
    this.settleFirst();
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
    this.applied = this.scope();
    const scope = this.applied;
    const agents: Agent[] = [];
    for (const t of s.terminals) {
      if (!inScope(scope, t.address)) continue;
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
    this.settleFirst();
  }

  private onEvent(e: CoreEvent | CoreUnknownEvent): void {
    if (e.seq <= this.seq) return; // already covered by the snapshot
    this.seq = e.seq;
    this.eventAt = this.now();
    const term = e.terminal;
    if (term === undefined) {
      // A `doc` event: not about an agent, but it says a document moved, so
      // a reader of it (the Spaces screen's layout) can tell when to re-read.
      if (e.type === "doc") {
        const d = (e as Extract<CoreEvent, { type: "doc" }>).data;
        this.docVersions.set(d.name, d.version);
      }
      return;
    }
    const id = coreId(term);
    const store = this.o.store;
    const prev = store.snapshot().find((a) => a.agentId === id) ?? null;
    const ev = e as CoreEvent;

    // Keep a record per terminal so an event can promote a non-agent.
    let record = this.records.get(term);
    if (ev.type === "created" || ev.type === "restarted") record = ev.data;
    else if (ev.type === "labels") {
      // Kept current either way: the name an unnamed agent takes from its tab
      // is read from the record's labels on the next event too.
      record = ev.data.record ?? (record ? { ...record, labels: ev.data.labels } : record);
    }
    else if (ev.type === "status" && record) record = { ...record, status: ev.data.status, status_ms: this.now() };
    // Kept so a terminal hidden by the machine scope comes back current when
    // the scope widens (`rescope` builds agents from these records).
    else if (ev.type === "turn" && record) record = { ...record, turn: ev.data.turn };
    // The rest keep the records a faithful `terminal.list`, which is what the
    // Spaces screen now reads instead of asking the core (`terminals()`).
    else if (ev.type === "finished" && record) record = { ...record, state: "finished", ...ev.data };
    else if (ev.type === "title" && record) record = { ...record, title: ev.data.title };
    else if (ev.type === "foreground" && record) record = { ...record, foreground: ev.data };
    else if (ev.type === "size" && record) record = { ...record, cols: ev.data.cols, rows: ev.data.rows };
    else if (ev.type === "keep" && record) record = { ...record, keep: ev.data.keep };
    if (ev.type === "removed") this.records.delete(term);
    else if (record) this.records.set(term, record);

    // Recorded above either way, so a later change of scope can show it; but
    // out of scope it never becomes an agent.
    if (!inScope(this.applied, term, e.machine)) return;

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
