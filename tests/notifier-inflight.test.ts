import { expect, test } from "bun:test";
import { Notifier, type TimerHandle } from "@server/notify/notifier";
import type { Agent, NotifyTrigger } from "@shared/types";

const NOW = 1_700_000_000_000;

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "schema-migration",
  task: "Backfilling the index", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", stateSince: NOW,
  updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
});

/**
 * The other harnesses resolve `send` immediately, so nothing in them can
 * observe what happens to per-agent state while a send is IN FLIGHT — and a
 * Telegram POST takes up to 10 seconds, long enough for a delegating agent to
 * transition two or three times underneath it. Everything after
 * `await this.o.send(...)` in `#fire` therefore runs in a world that may have
 * moved on, and that is what this file drives.
 *
 * `send` here parks: it records the attempt and returns a promise the test
 * resolves by hand, so the interleaving is stated in the test rather than left
 * to scheduling luck.
 */
function harness(o: { cooldownMs?: number; settleMs?: Partial<Record<NotifyTrigger, number>> } = {}) {
  /** Every send ATTEMPT, recorded when it starts rather than when it settles. */
  const attempts: string[] = [];
  let now = NOW;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  /** Callbacks are kept after they fire, so `refire` can replay one. */
  const fns = new Map<number, () => void>();
  let inflight: ((r: { ok: boolean; detail: string | null }) => void) | null = null;

  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: {
        enabled: true,
        triggers: ["blocked", "done"] as NotifyTrigger[],
        settleMs: { blocked: 5_000, done: 10_000, ...o.settleMs },
        mutedUntil: null,
        // 0 unless a test says otherwise: the cooldown's own deferral is
        // covered in tests/notifier-timing.test.ts, and a 60s window here
        // would push every assertion behind a deferral that is not what these
        // tests are measuring.
        cooldownMs: o.cooldownMs ?? 0,
      },
      publicUrl: null,
    }),
  };

  const n = new Notifier({
    settings: store as never,
    send: async (text: string) => {
      if (inflight !== null) throw new Error("two sends in flight — this harness models one");
      attempts.push(text);
      return new Promise<{ ok: boolean; detail: string | null }>((resolve) => { inflight = resolve; });
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      fns.set(id, fn);
      return id as unknown as TimerHandle;
    },
    clearTimer: (h) => { timers.delete(h as unknown as number); },
  });

  async function advance(ms: number): Promise<void> {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) { timers.delete(id); t.fn(); }
    }
    await Bun.sleep(1);
  }

  /** Settle the parked send, then let `#fire`'s continuation run. */
  async function resolve(r: { ok: boolean; detail: string | null }): Promise<void> {
    if (inflight === null) throw new Error("no send is in flight");
    const f = inflight;
    inflight = null;
    f(r);
    await Bun.sleep(1);
  }

  return {
    n, attempts, advance, resolve,
    /** Live timers, whether or not the notifier still tracks them. */
    pending: () => timers.size,
    /** Replay an already-fired callback. See its one caller for why. */
    refire: (id: number) => { fns.get(id)!(); },
  };
}

const transitionTo = (n: Notifier, state: Agent["state"]): void => {
  n.observe({ upserted: [agent({ state })], removedIds: [] });
};

test("a failed send that lands after the state moved on does not re-arm over the new episode", async () => {
  // The interleaving that broke the "at most one pending timer per agent"
  // invariant: a blocked send is still in flight when the agent delegates,
  // and the retry decision is taken after the await, in a world where a
  // `done` window is already ticking.
  //
  // Two things must hold. The retry must not ADD a second live timer (which
  // `#pending.set` without a cancel did, orphaning one beyond the reach of
  // `#cancel` and `dispose()`), and it must not REPLACE the done window
  // either — a retry for an episode that has ended has nothing true left to
  // say, and cancelling the done timer to install it loses the finish the
  // operator was actually waiting for.
  const h = harness();
  transitionTo(h.n, "working");
  transitionTo(h.n, "blocked");
  await h.advance(5_000);
  expect(h.attempts).toEqual(["schema-migration is blocked"]);
  expect(h.pending()).toBe(0);

  // The subagent handoff, mid-flight.
  await h.advance(2_000);
  transitionTo(h.n, "working");
  transitionTo(h.n, "done");
  expect(h.pending()).toBe(1);

  // t=8000: the blocked send finally fails, three seconds into a done window.
  await h.advance(1_000);
  await h.resolve({ ok: false, detail: "chat not found" });
  expect(h.pending()).toBe(1);
  // Never swallowed: the failure is on /api/health either way.
  expect(h.n.lastError).toBe("chat not found");

  // And the one live timer is still the DONE one, so the finish is not lost.
  await h.advance(9_000);
  expect(h.attempts).toEqual(["schema-migration is blocked", "schema-migration is done"]);
  await h.resolve({ ok: true, detail: null });

  // Nothing was left where shutdown cannot reach it.
  h.n.dispose();
  expect(h.pending()).toBe(0);
});

test("a successful send that lands after the state flapped back does not suppress the new episode", async () => {
  // `#lastNotified` must not outlive its episode. Here the agent leaves
  // `blocked` and returns to it while the first message is still in flight,
  // so the late `#lastNotified.set` lands AFTER `#see` cleared it for the
  // second episode — and the second episode's timer then reads "already
  // announced" and drops a real notification.
  //
  // State alone cannot tell the two apart: `#lastSeen` reads "blocked" at
  // both instants. Only the episode number does.
  const h = harness();
  transitionTo(h.n, "working");
  transitionTo(h.n, "blocked");
  await h.advance(5_000);
  expect(h.attempts).toEqual(["schema-migration is blocked"]);

  await h.advance(1_000);
  transitionTo(h.n, "working");
  transitionTo(h.n, "blocked");
  expect(h.pending()).toBe(1);

  await h.resolve({ ok: true, detail: null });
  expect(h.pending()).toBe(1); // the second episode's window is untouched

  await h.advance(5_000);
  expect(h.attempts).toEqual(["schema-migration is blocked", "schema-migration is blocked"]);
  await h.resolve({ ok: true, detail: null });
});

test("a timer callback replayed after its own entry is gone leaves the live window alone", async () => {
  // A SIMULATION, and deliberately labelled as one. With `#arm` cancelling
  // before it sets, no reachable interleaving fires a callback whose
  // `#pending` entry has been replaced — the cancel clears the timer first.
  // The identity check on the callback's `#pending.delete` is depth against
  // that assumption failing (a runtime that runs an already-queued timer
  // after `clearTimeout`, or a future edit that arms without cancelling), so
  // the only way to exercise it is for the harness to play such a runtime and
  // hand a fired callback back a second time.
  //
  // What must not happen is the replayed callback deleting the DONE entry:
  // that entry's timer is live, and `#pending` is the only place `dispose()`
  // and `#cancel` can find it.
  const h = harness();
  transitionTo(h.n, "working");
  transitionTo(h.n, "blocked");
  await h.advance(5_000); // timer 1 fires; the blocked send parks
  await h.advance(2_000);
  transitionTo(h.n, "working");
  transitionTo(h.n, "done"); // timer 2, the live done window

  h.refire(1);
  await h.resolve({ ok: false, detail: "chat not found" });

  h.n.dispose();
  expect(h.pending()).toBe(0);
  await h.advance(60_000);
  expect(h.attempts).toEqual(["schema-migration is blocked"]);
});

/**
 * A herdr `pane_id` is reused: the pane closes and a different agent opens in
 * the same slot. `#forget` deletes every per-agent entry, including the episode
 * id — it must, or the maps grow for the life of the process — so an episode id
 * drawn from the DEPARTED agent's own previous value is reissued to the
 * ARRIVING one, and a send still in flight for the first agent then passes the
 * `current` check while holding the second agent's slot.
 *
 * Both halves of that are driven below, because the two harms are different:
 * a success writes `#lastNotified` and silently eats the new agent's first
 * notification, and a failure re-arms — cancelling the new agent's live window
 * and sending a message composed from the DEPARTED agent, carrying its name.
 *
 * Each assertion names what was sent rather than counting sends, or "the new
 * agent's message was dropped" is indistinguishable from "it has not gone out
 * yet", and "sent under the wrong name" is indistinguishable from "sent".
 */
const departed = (state: Agent["state"]): Agent => agent({ state, name: "docs-cleanup" });
const arrived = (state: Agent["state"]): Agent => agent({ state, name: "flaky-test-fix" });

test("a reused pane id does not inherit the departed agent's in-flight send (success)", async () => {
  const h = harness();
  h.n.observe({ upserted: [departed("working")], removedIds: [] });
  h.n.observe({ upserted: [departed("blocked")], removedIds: [] });
  await h.advance(5_000);
  expect(h.attempts).toEqual(["docs-cleanup is blocked"]);

  // The pane closes mid-send, and a different agent takes the id.
  h.n.observe({ upserted: [], removedIds: ["w1:p1"] });
  h.n.observe({ upserted: [arrived("working")], removedIds: [] });
  h.n.observe({ upserted: [arrived("blocked")], removedIds: [] });
  expect(h.pending()).toBe(1);

  // The departed agent's send finally succeeds. It must write nothing.
  await h.resolve({ ok: true, detail: null });
  expect(h.pending()).toBe(1);

  await h.advance(5_000);
  expect(h.attempts).toEqual(["docs-cleanup is blocked", "flaky-test-fix is blocked"]);
  await h.resolve({ ok: true, detail: null });
});

test("a reused pane id does not inherit the departed agent's retry (failure)", async () => {
  const h = harness();
  h.n.observe({ upserted: [departed("working")], removedIds: [] });
  h.n.observe({ upserted: [departed("blocked")], removedIds: [] });
  await h.advance(5_000);

  h.n.observe({ upserted: [], removedIds: ["w1:p1"] });
  h.n.observe({ upserted: [arrived("working")], removedIds: [] });
  h.n.observe({ upserted: [arrived("blocked")], removedIds: [] });

  // The departed agent's send fails. Its retry belongs to an agent that is
  // gone, so it must neither fire nor cancel the arriving agent's window.
  await h.resolve({ ok: false, detail: "chat not found" });
  expect(h.n.lastError).toBe("chat not found");

  await h.advance(5_000);
  expect(h.attempts).toEqual(["docs-cleanup is blocked", "flaky-test-fix is blocked"]);
  await h.resolve({ ok: true, detail: null });
});
