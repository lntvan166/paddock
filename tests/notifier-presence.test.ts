import { expect, test } from "bun:test";
import { Notifier } from "@server/notify/notifier";
import type { Agent, AgentState, InlineKeyboard } from "@shared/types";

const NOW = 1_700_000_000_000;
const PHONE = "dk-phone";
const TABLET = "dk-tablet";

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "flaky-test-fix",
  task: "Quarantine the retry test", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", harness: "claude",
  stateSince: NOW, stateSinceExact: true,
  updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
});

type PushPayload = { name: string; state: AgentState; agentId: string; skipDeviceKeys: Set<string> };

/** Mirrors `tests/notifier-push.test.ts`'s harness, plus presence. */
function buildNotifier(o: {
  send?: (text: string, m?: InlineKeyboard) => Promise<{ ok: boolean; detail: string | null }>;
  sendPush?: (p: PushPayload) => Promise<void>;
  viewers?: (agentId: string) => Set<string>;
  pushDeviceKeys?: () => Set<string>;
  telegram?: { token: string; chatId: string };
  skipWhileViewing?: boolean;
  cooldownMs?: number;
}) {
  const store = {
    current: () => ({
      // No Telegram by default here: presence governs push, and a configured
      // Telegram would deliver every one of these and mask the behaviour.
      telegram: o.telegram ?? { token: "", chatId: "" },
      notify: {
        telegram: true, triggers: ["blocked"],
        settleMs: { blocked: 0, done: 0 }, mutedUntil: null,
        cooldownMs: o.cooldownMs ?? 60_000,
        skipWhileViewing: o.skipWhileViewing ?? true,
      },
      push: { enabled: true },
      publicUrl: "https://paddock.example.com",
    }),
  };
  return new Notifier({
    settings: store as never,
    send: o.send ?? (async () => ({ ok: true, detail: null })),
    sendPush: o.sendPush,
    viewers: o.viewers,
    pushDeviceKeys: o.pushDeviceKeys,
    now: () => NOW,
  });
}

async function settleBlocked(n: Notifier, over: Partial<Agent> = {}) {
  n.observe({ upserted: [agent({ ...over, state: "working" })], removedIds: [] });
  n.observe({ upserted: [agent({ ...over, state: "blocked" })], removedIds: [] });
  await Bun.sleep(5);
}

test("no push is sent when the only device is showing that agent", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  // Not "sent and then dropped by the transport" — nothing is dispatched at
  // all, which is also what leaves the cooldown unspent.
  expect(push).toEqual([]);
});

test("a viewer of a DIFFERENT agent suppresses nothing", async () => {
  // Suppression is per agent, not per app. Reading docs-cleanup must never
  // silence flaky-test-fix.
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: (id) => (id === "w9:p9" ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});

test("a second device that is not looking is still told", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE, TABLET]),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
  // The phone is named to the transport, which skips it. Partial suppression
  // sends: you were told, on a device that was not already showing you.
  expect([...push[0]!.skipDeviceKeys]).toEqual([PHONE]);
});

test("with nothing subscribed, a viewer suppresses nothing", async () => {
  // An empty roster is not suppression, and deferring would wait for a
  // departure that can never happen.
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set(),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});

test("Telegram still delivers while push is withheld", async () => {
  // A device key identifies one browser. A Telegram chat can be read from a
  // laptop, so presence can make no claim about it.
  const telegram: string[] = [];
  const push: PushPayload[] = [];
  const n = buildNotifier({
    telegram: { token: "1:A", chatId: "555" },
    send: async (t) => { telegram.push(t); return { ok: true, detail: null }; },
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  expect(telegram).toHaveLength(1);
  expect(push).toEqual([]);
});

test("the toggle off restores today's behaviour exactly", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    skipWhileViewing: false,
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
  expect([...push[0]!.skipDeviceKeys]).toEqual([]);
});

test("a notifier with no presence getters behaves as it does today", async () => {
  // The demo server and an attached tunnel construct a notifier without
  // presence. Absent getters must mean "no suppression", never "suppress
  // everything".
  const push: PushPayload[] = [];
  const n = buildNotifier({ sendPush: async (p) => { push.push(p); } });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});
