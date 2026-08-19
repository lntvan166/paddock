import { expect, test } from "bun:test";
import { Notifier, type TimerHandle } from "@server/notify/notifier";
import type { Agent, NotifyTrigger } from "@shared/types";

const NOW = 1_700_000_000_000;

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
  task: "Extract auth middleware", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", stateSince: NOW,
  updatedAt: NOW, acknowledgedAt: null, ...over,
});

/**
 * A controllable clock and timer queue. Timers are injected rather than real
 * because a settle window is 5-10 SECONDS: a test that waited would add ten
 * seconds to `make test` for every case, and one that lowered the window to
 * 1ms would stop testing the thing that matters (that the window is read from
 * settings at all).
 */
function harness(o: {
  settleMs?: Partial<Record<NotifyTrigger, number>>;
  triggers?: NotifyTrigger[];
  cooldownMs?: number;
} = {}) {
  const sent: string[] = [];
  let now = NOW;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: {
        enabled: true,
        triggers: o.triggers ?? (["blocked", "done"] as NotifyTrigger[]),
        settleMs: { blocked: 5_000, done: 10_000, ...o.settleMs },
        mutedUntil: null,
        cooldownMs: o.cooldownMs ?? 0,
      },
      publicUrl: null,
    }),
  };

  const n = new Notifier({
    settings: store as never,
    send: async (text: string) => { sent.push(text); return { ok: true, detail: null }; },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id as unknown as TimerHandle;
    },
    clearTimer: (h) => { timers.delete(h as unknown as number); },
  });

  /** Advance the clock and run every timer that has come due. */
  async function advance(ms: number): Promise<void> {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) { timers.delete(id); t.fn(); }
    }
    await Bun.sleep(1); // let the fire path's await settle
  }

  return { n, sent, advance, pending: () => timers.size };
}

test("a subagent handoff sends nothing at all", async () => {
  // THE reported bug. A main agent that delegates goes working -> done the
  // instant the subagent returns, then back to working when it reviews the
  // result. Firing on the edge makes that message true when sent and stale
  // when read, which is worse than silence: it teaches the operator to
  // ignore the channel.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(3_000);
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  // A second delegation, back to back with the first, before the first
  // (uncancelled) timer would have fired. This is what actually exercises
  // the cancel: the fire-time `lastSeen` guard alone (`#fire`'s first check)
  // already protects a SINGLE aborted handoff, because by the time the
  // orphaned timer fires the agent is back to "working" and the guard bails.
  // It does NOT protect this case, where the agent is "done" again when the
  // first, orphaned timer comes due — that timer would delete the SECOND
  // (still-live) pending entry out of `#pending` and fire early, sending a
  // message about a state that has only held for 7s of its 10s window.
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(7_000); // t=10_000 from the first arm: the orphaned timer's due time
  expect(h.sent).toEqual([]);
  await h.advance(3_000); // t=13_000: the second arm's own due time
  expect(h.sent).toEqual(["api-refactor is done"]);
});

test("a state held for the whole window fires exactly once", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(9_999);
  expect(h.sent).toEqual([]);
  await h.advance(2);
  expect(h.sent).toEqual(["api-refactor is done"]);
  // A later task-line-only delta must not re-announce the same state.
  h.n.observe({ upserted: [agent({ state: "done", task: "wrote the report" })], removedIds: [] });
  await h.advance(60_000);
  expect(h.sent).toEqual(["api-refactor is done"]);
});

test("blocked uses its own shorter window, not done's", async () => {
  // If both shared one window, the alert the operator most wants fast would
  // wait as long as the one that lies.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await h.advance(5_000);
  expect(h.sent).toEqual(["api-refactor is blocked"]);
});

test("a settleMs of 0 fires on the edge, so the feature can be turned off", async () => {
  const h = harness({ settleMs: { done: 0 } });
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(0);
  expect(h.sent).toEqual(["api-refactor is done"]);
});

test("a non-trigger state arms no timer", async () => {
  const h = harness({ triggers: ["blocked"] });
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  expect(h.pending()).toBe(0);
});

test("first sight after boot arms nothing", async () => {
  // Preserved from v2 deliberately: paddock cannot tell "just blocked" from
  // "blocked for an hour", and announcing every agent on every restart is
  // its own noise problem.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await h.advance(60_000);
  expect(h.sent).toEqual([]);
});

test("dispose clears pending timers", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  expect(h.pending()).toBe(1);
  h.n.dispose();
  expect(h.pending()).toBe(0);
  await h.advance(60_000);
  expect(h.sent).toEqual([]);
});

test("a removed agent forgets that it was notified, so a returning id can notify again", async () => {
  // #lastNotified surviving a removal would silently suppress the first real
  // notification for whatever agent next holds that pane id.
  const h = harness({ settleMs: { done: 0 } });
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(0);
  h.n.observe({ upserted: [], removedIds: ["w1:p1"] });
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(0);
  expect(h.sent).toEqual(["api-refactor is done", "api-refactor is done"]);
});
