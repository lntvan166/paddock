/**
 * Who is looking at what, right now.
 *
 * In `state/` because both `ws/serve.ts` (which writes it) and `notify/`
 * (which reads it) need it, and neither may import the other —
 * `docs/architecture.md` fixes that direction. This module imports nothing
 * from either, and nothing about herdr or about transport.
 *
 * Its only consumer semantics: `viewers(agentId)` answers "which DEVICES have
 * this agent's pane open and awake". A push that would land on one of those
 * devices is telling it something it is already showing.
 */

export interface PresenceEntry {
  /** `base64url(SHA-256(endpoint))`, or null for a browser with no
   *  subscription — recorded, but never a viewer, because there is no push
   *  target it could suppress. */
  deviceKey: string | null;
  agentId: string | null;
  at: number;
}

/** Three missed 20s heartbeats. See `#staleMs` below. */
const DEFAULT_STALE_MS = 60_000;

export class PresenceStore {
  /**
   * Keyed by the CONNECTION, never by the device key.
   *
   * A Safari tab and the installed PWA on one phone share a device key and
   * have separate sockets and separate location hashes. Keyed by device key,
   * whichever spoke last would overwrite the other: the tab on the agent list
   * would erase the PWA's "viewing api-refactor" and suppression would
   * flicker on which surface moved most recently. So each connection holds its
   * own entry and `viewers` unions them — a device is viewing an agent if ANY
   * of its connections is.
   */
  #entries = new Map<object, PresenceEntry>();
  #listeners: ((agentId: string) => void)[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #now: () => number;
  /**
   * How long an entry counts without being refreshed.
   *
   * The client re-sends its frame once per heartbeat it receives, so the reply
   * IS the liveness proof and no new timer exists on either side. Three missed
   * heartbeats is the allowance. This covers the case the socket's own `close`
   * cannot: iOS suspending a backgrounded PWA delivers no `visibilitychange`
   * and may leave the socket hanging, and a stale entry would suppress
   * notifications for a phone asleep in a pocket.
   *
   * `viewers()` reads this cutoff directly, so no READ is ever off by more
   * than `#staleMs` — but RELEASE (the `onChange` that lets a deferred
   * notification re-fire on this TTL path) only happens when `sweep()` next
   * runs, up to `#sweepMs` later. Worst case is therefore `#staleMs +
   * #sweepMs` (60s + 20s = 80s) from the last refresh to the re-fire, not
   * `#staleMs` alone — see `#sweepMs` below.
   */
  readonly #staleMs: number;
  /**
   * How often `sweep()` runs. Bounds how STALE a release can be, not a read:
   * an entry can sit expired-but-not-yet-swept for up to this long before its
   * `onChange` fires, which is the extra time added on top of `#staleMs` for
   * the suspended-PWA path described above.
   */
  readonly #sweepMs: number;

  constructor(o: { now?: () => number; staleMs?: number; sweepMs?: number } = {}) {
    this.#now = o.now ?? Date.now;
    this.#staleMs = o.staleMs ?? DEFAULT_STALE_MS;
    this.#sweepMs = o.sweepMs ?? 20_000;
  }

  set(client: object, e: { deviceKey: string | null; agentId: string | null }): void {
    const prev = this.#entries.get(client);
    this.#entries.set(client, { deviceKey: e.deviceKey, agentId: e.agentId, at: this.#now() });
    // The agent this client LEFT may now have no viewers at all, which is the
    // event a deferred notification is waiting for. The agent it arrived at
    // needs no announcement: gaining a viewer never releases anything.
    if (prev !== undefined && prev.agentId !== null && prev.agentId !== e.agentId) {
      this.#emit(prev.agentId);
    }
  }

  drop(client: object): void {
    const prev = this.#entries.get(client);
    if (prev === undefined) return;
    this.#entries.delete(client);
    if (prev.agentId !== null) this.#emit(prev.agentId);
  }

  viewers(agentId: string): Set<string> {
    const cutoff = this.#now() - this.#staleMs;
    const out = new Set<string>();
    for (const e of this.#entries.values()) {
      if (e.agentId !== agentId) continue;
      if (e.at < cutoff) continue;
      if (e.deviceKey !== null) out.add(e.deviceKey);
    }
    return out;
  }

  /**
   * Drop expired entries, announcing each agent that may have lost a viewer.
   *
   * PUBLIC so tests drive expiry on an injected clock without waiting out a
   * real interval, and so expiry is an EVENT like every other release rather
   * than a condition someone has to poll for.
   */
  sweep(): void {
    const cutoff = this.#now() - this.#staleMs;
    for (const [client, e] of [...this.#entries]) {
      if (e.at >= cutoff) continue;
      this.#entries.delete(client);
      if (e.agentId !== null) this.#emit(e.agentId);
    }
  }

  onChange(cb: (agentId: string) => void): void {
    this.#listeners.push(cb);
  }

  startSweep(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.sweep(), this.#sweepMs);
    // A presence sweep must never be the reason the process stays alive —
    // the same rule the notifier's settle timers follow.
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#entries.clear();
    this.#listeners.length = 0;
  }

  /**
   * Reported, never rethrown. A change fires from a socket's `close` handler
   * and from a timer: an exception escaping here would take down a connection
   * teardown, or the process, to deliver a hint about a notification.
   */
  #emit(agentId: string): void {
    for (const cb of this.#listeners) {
      try {
        cb(agentId);
      } catch (e) {
        console.info(`paddock: presence listener failed: ${(e as Error).message}`);
      }
    }
  }
}
