import { applyStatusEvent, toAgents, workspaceLabels } from "@server/herdr/adapter";
import { checkAgentShape, type ShapeVerdict } from "@server/herdr/shape";
import {
  EVENT_AGENT_DETECTED,
  EVENT_PANE_CLOSED,
  EVENT_PANE_EXITED,
  EVENT_STATUS_CHANGED,
  GLOBAL_SUBSCRIPTIONS,
  statusSubscriptions,
  type Subscription,
} from "@server/herdr/socket";
import type { AgentStore, Delta } from "@server/state/store";
import type {
  HerdrAgentRaw,
  HerdrEvent,
  HerdrStatusChanged,
  HerdrWorkspaceRaw,
} from "@shared/herdr-api";

export interface HerdrClientLike {
  request<T>(method: string, params?: object): Promise<T>;
  openStream(subs: Subscription[]): Promise<void>;
}

export interface SupervisorOptions {
  client: HerdrClientLike;
  store: AgentStore;
  onDelta: (d: Delta) => void;
  /** Healing reconcile interval. Push is the primary mechanism. */
  reconcileMs?: number;
  now?: () => number;
  /**
   * A background refresh or healing reconcile failed.
   *
   * These are the calls nobody is awaiting — the three event-driven
   * `refresh()`es and the 30s timer — so their rejections used to end in a
   * `console.error` and nothing else. Wired to the reconnect keeper, a
   * failure now arms recovery instead of being logged and forgotten. Errors
   * are still logged; this is additional, not a replacement.
   */
  onBackgroundFailure?: (err: unknown) => void;
  /**
   * Fired only when the verdict on herdr's `agent.list` shape CHANGES.
   *
   * Separate from `onBackgroundFailure` because this is not a failure to
   * recover from — the stream is healthy and herdr is answering. It is a
   * contract change, and the only useful response is to tell the operator
   * which field moved.
   */
  onShapeChange?: (verdict: ShapeVerdict) => void;
  /**
   * The event stream was (re)subscribed, with this many panes behind it.
   *
   * Exists so boot can fold "subscribed" into a single status line instead of
   * printing it — pretty-printed over three lines — above the URL the operator
   * is actually looking for. When absent, `resubscribe` logs it itself, so
   * nothing goes quiet by omission.
   */
  onSubscribed?: (panes: number) => void;
}

// Delivered names, not subscribe names — see src/server/herdr/socket.ts.
// EVENT_STATUS_CHANGED is dotted; the lifecycle ones are underscored.
const LIFECYCLE_GONE: string[] = [EVENT_PANE_CLOSED, EVENT_PANE_EXITED];

export class Supervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private labels = new Map<string, string>();
  private eventAt: number | null = null;
  /** Latest verdict on herdr's `agent.list` shape. See `herdr/shape.ts`. */
  private shapeVerdict: ShapeVerdict = { kind: "unknown" };
  private readonly now: () => number;
  private readonly reconcileMs: number;

  // Coalesces overlapping refresh() calls. While one is running, further
  // calls do not start a second reconcile+resubscribe chain — they only flag
  // that one more pass is needed once the current one finishes. See refresh().
  private refreshLoop: Promise<void> | null = null;
  private refreshQueued = false;

  // The sorted pane id set behind the currently open stream. Lets
  // resubscribe() skip the teardown/reopen when the set hasn't changed.
  private openPaneKey: string | null = null;

  // Bumped by every invalidateSubscription(). resubscribe() captures it before
  // awaiting openStream() and refuses to record a subscription as live if it
  // moved during that await — see resubscribe().
  private subscriptionGeneration = 0;

  constructor(private readonly opts: SupervisorOptions) {
    this.now = opts.now ?? Date.now;
    this.reconcileMs = opts.reconcileMs ?? 30_000;
  }

  get lastEventAt(): number | null {
    return this.eventAt;
  }

  /**
   * The latest verdict on herdr's `agent.list` shape, for `/api/health`.
   *
   * Read rather than pushed, for the same reason `health()` reads
   * `stream.connected` instead of a cached boolean: a copy can go stale and
   * then lie, and this one exists precisely to be trusted.
   */
  get shape(): ShapeVerdict {
    return this.shapeVerdict;
  }

  /**
   * Reconcile BEFORE subscribing. Status events are per-pane, so the pane set
   * has to be known to name it. Subscribing first would name no panes and
   * silently deliver nothing.
   */
  async start(): Promise<void> {
    await this.reconcile();
    await this.resubscribe();
    this.timer = setInterval(() => {
      this.reconcile().catch((err) => this.backgroundFailed("healing reconcile", err));
    }, this.reconcileMs);
  }

  /**
   * Re-open the event stream naming every currently known agent pane, plus the
   * globals. A subscription set cannot be extended in place, so any change to
   * the pane set means replacing the stream.
   *
   * No-op when the pane set is unchanged from what's already open: this keeps
   * repeated refresh() passes (see the coalescing loop below) cheap and
   * idempotent, and avoids needless stream churn when nothing actually moved.
   *
   * The key is recorded only AFTER `openStream()` resolves. Recording it
   * before the await would mean a rejected subscribe (herdr down, socket
   * refused, subscription rejected) gets permanently remembered as live: every
   * later resubscribe() computing the same pane set would then hit the early
   * return and skip openStream() forever, with nothing — not even the 30s
   * timer, which only reconciles — ever noticing or retrying.
   *
   * ...and it is recorded only if NOTHING invalidated the subscription while
   * that await was in flight. An invalidateSubscription() landing mid-open
   * (a genuine drop reported while an unrelated event's refresh is between
   * its openStream() and its post-await write) was otherwise simply
   * overwritten: the follow-up pass then took the unchanged-pane-set early
   * return, refresh() resolved successfully, and the keeper logged "event
   * stream recovered" for a stream that was never reopened.
   */
  private async resubscribe(): Promise<void> {
    const paneIds = this.opts.store.snapshot().map((a) => a.agentId);
    const key = JSON.stringify([...paneIds].sort());
    if (key === this.openPaneKey) return;

    const generation = this.subscriptionGeneration;
    await this.opts.client.openStream([
      ...statusSubscriptions(paneIds),
      ...GLOBAL_SUBSCRIPTIONS,
    ]);
    if (generation !== this.subscriptionGeneration) {
      // Something learned the stream was dead while this open was in flight.
      // Whether this brand-new stream outlived that news is unknowable from
      // here, so do not claim it as live: leaving the key clear costs one
      // extra reopen, claiming it wrongly costs every future one.
      console.info("herdr: subscription invalidated mid-open; not recorded as live");
      return;
    }
    this.openPaneKey = key;
    // Handed out rather than logged here when a handler exists, so that ONE
    // subscribe produces one line and the boot-versus-steady-state decision
    // lives in one place (see boot-log.ts). Without a handler this logs exactly
    // as it always did — a Supervisor built in a test is not made quiet by
    // this seam.
    if (this.opts.onSubscribed) this.opts.onSubscribed(paneIds.length);
    else console.info("herdr: subscribed", { panes: paneIds.length });
  }

  /**
   * Clear the recorded subscription key. Call this whenever the stream is
   * known to be closed (e.g. drop-recovery), so the next refresh()
   * re-subscribes rather than taking resubscribe()'s unchanged-pane-set early
   * return — which would otherwise believe the (now-dead) stream is still
   * live and skip re-opening it, even though the pane set itself never
   * changed.
   *
   * Synchronous and unconditional. The generation bump is what makes it
   * durable against an in-flight resubscribe() overwriting it after the fact.
   */
  invalidateSubscription(): void {
    this.openPaneKey = null;
    this.subscriptionGeneration++;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A refresh or reconcile that nobody is awaiting failed.
   *
   * Logging it and moving on is how a system stops healing without saying so:
   * these are exactly the paths that discover herdr is gone, and every one of
   * them used to end here. The failure is still logged, and now also reaches
   * whoever can do something about it (the reconnect keeper).
   */
  private backgroundFailed(what: string, err: unknown): void {
    console.error(`herdr: ${what} failed`, err);
    this.opts.onBackgroundFailure?.(err);
  }

  /**
   * Record a verdict, announcing only CHANGES.
   *
   * `reconcile` runs on a 30s timer and on every event-driven refresh, so
   * announcing an unchanged verdict each time would bury the one line that
   * mattered under hundreds of identical ones — the shape of "never swallow
   * errors" that still leaves the error findable.
   */
  private noteShape(next: ShapeVerdict): void {
    // `unknown` means zero rows were inspected — "we learned nothing", which
    // must not erase what we did learn. Without this, a real break was silently
    // cleared the moment the operator closed their panes: `health.schemaWarning`
    // returned to null and the log announced every field present, while the
    // contract was still broken. Only positive evidence of health clears a break.
    if (next.kind === "unknown" && this.shapeVerdict.kind !== "unknown") return;

    const key = (v: ShapeVerdict) =>
      v.kind === "broken" ? `broken:${v.missing.join(",")}|${v.unknownStatuses.join(",")}` : v.kind;
    const changed = key(next) !== key(this.shapeVerdict);
    this.shapeVerdict = next;
    if (changed) this.opts.onShapeChange?.(next);
  }

  async reconcile(): Promise<Delta> {
    const now = this.now();

    const ws = await this.opts.client.request<{ workspaces: HerdrWorkspaceRaw[] }>(
      "workspace.list",
      {},
    );
    this.labels = workspaceLabels(ws.workspaces ?? []);

    const list = await this.opts.client.request<{ agents: HerdrAgentRaw[] }>("agent.list", {});

    // Checked on the RAW response, before `toAgent` maps it. After mapping,
    // every absence has already been papered over by a fallback — the whole
    // point is to see what herdr actually sent.
    //
    // Every reconcile, not just at startup: a herdr upgraded underneath a
    // running paddock is the case a boot-time assertion cannot see, and it is
    // the ordinary case, because the protocol is only read when the daemon is
    // first reached.
    this.noteShape(checkAgentShape(list.agents ?? []));

    // `toAgents`, not `.map(toAgent)`: the fallback label for an unnamed agent
    // depends on the other rows (see adapter.ts), so it cannot be decided one
    // row at a time. Recomputed here every reconcile, which is what lets a
    // disambiguating suffix appear and disappear as agents come and go.
    const agents = toAgents(list.agents ?? [], {
      hostId: this.opts.store.hostId,
      labels: this.labels,
      now,
    });

    const delta = this.opts.store.replaceAll(agents, now);
    if (delta.upserted.length || delta.removedIds.length) this.opts.onDelta(delta);
    return delta;
  }

  /**
   * Re-learn the pane set and re-point the stream at it. Used whenever the set
   * changed: a new agent, a closed pane, or a status event for a pane we do not
   * know. Reconcile first — resubscribe() reads the pane set from the store.
   *
   * Public because Task 16 also calls it to recover after the stream drops.
   *
   * handleEvent() below can call this from three independent event paths with
   * no ordering guarantee between them. Each call is two herdr round-trips
   * followed by a stream teardown/reopen; launching one such chain per event
   * would let them run concurrently and settle out of order, so the LAST TO
   * RESOLVE — not the last issued — would decide the live subscription set. A
   * refresh started for an older event could then resolve after a newer one
   * and reopen the stream naming a pane set that is already stale, with
   * nothing to correct it before the next healing reconcile up to 30s later.
   *
   * So at most one refresh runs at a time. A call that arrives while one is
   * already in flight does not start a second chain — it only flags that one
   * more pass is needed once the current one finishes, and every such call
   * folds into that single follow-up pass rather than queuing one each.
   */
  async refresh(): Promise<void> {
    if (this.refreshLoop) {
      this.refreshQueued = true;
      return this.refreshLoop;
    }
    this.refreshLoop = this.runRefreshLoop();
    try {
      await this.refreshLoop;
    } finally {
      this.refreshLoop = null;
    }
  }

  private async runRefreshLoop(): Promise<void> {
    do {
      this.refreshQueued = false;
      await this.reconcile();
      await this.resubscribe();
    } while (this.refreshQueued);
  }

  /**
   * Three kinds matter, and they do not share a naming convention:
   *
   *   pane.agent_status_changed  (dotted)      a known agent changed state
   *   pane_agent_detected        (underscored) a new agent appeared
   *   pane_closed / pane_exited  (underscored) an agent went away
   *
   * The status event carries no `name`, so it merges into a known agent. The
   * two lifecycle kinds change the pane set, which means the subscription set
   * is now stale and the stream must be re-opened.
   */
  handleEvent(e: HerdrEvent): void {
    if (e.event === EVENT_AGENT_DETECTED) {
      this.eventAt = this.now();
      console.info("herdr: new agent detected, resubscribing", (e.data as any).pane_id);
      this.refresh().catch((err) => this.backgroundFailed("refresh", err));
      return;
    }

    if (LIFECYCLE_GONE.includes(e.event)) {
      this.eventAt = this.now();
      const paneId = (e.data as any).pane_id as string;
      const delta = this.opts.store.remove(paneId);
      if (delta) {
        console.info("herdr: agent gone", paneId);
        this.opts.onDelta(delta);
      }
      // The closed pane is still named in the live subscription set.
      this.refresh().catch((err) => this.backgroundFailed("refresh", err));
      return;
    }

    if (e.event !== EVENT_STATUS_CHANGED) return;
    this.eventAt = this.now();
    const data = e.data as unknown as HerdrStatusChanged;

    if (!this.opts.store.has(data.pane_id)) {
      console.info("herdr: event for unknown agent, reconciling", data.pane_id);
      this.refresh().catch((err) => this.backgroundFailed("refresh", err));
      return;
    }

    const now = this.now();
    const next = this.opts.store.applyEvent(data.pane_id, (prev) =>
      applyStatusEvent(prev, data, now),
    );
    if (next) this.opts.onDelta({ upserted: [next], removedIds: [] });
  }
}
