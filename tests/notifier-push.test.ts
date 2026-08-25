import { expect, test } from "bun:test";
import { Notifier } from "@server/notify/notifier";
import type { Agent, AgentState, InlineKeyboard } from "@shared/types";

const NOW = 1_700_000_000_000;

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
  task: "Extract auth middleware", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", harness: "claude",
  stateSince: NOW, stateSinceExact: true,
  updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
});

type PushPayload = { name: string; state: AgentState; agentId: string };

/** Mirrors `tests/notifier.test.ts`'s harness — same stub store, same clock. */
function buildNotifier(o: {
  send?: (text: string, m?: InlineKeyboard) => Promise<{ ok: boolean; detail: string | null }>;
  sendPush?: (p: PushPayload) => Promise<void>;
}) {
  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: {
        enabled: true, triggers: ["blocked"],
        settleMs: { blocked: 0, done: 0 }, mutedUntil: null, cooldownMs: 60_000,
      },
      push: { enabled: true },
      publicUrl: "https://paddock.example.com",
    }),
  };
  return new Notifier({
    settings: store as never,
    send: o.send ?? (async () => ({ ok: true, detail: null })),
    sendPush: o.sendPush,
    now: () => NOW,
  });
}

/** Drive a working -> blocked transition and let the settle fire. */
async function settleBlocked(n: Notifier, over: Partial<Agent> = {}) {
  n.observe({ upserted: [agent({ ...over, state: "working" })], removedIds: [] });
  n.observe({ upserted: [agent({ ...over, state: "blocked" })], removedIds: [] });
  await Bun.sleep(5);
}

test("a settled transition reaches both transports", async () => {
  const telegram: string[] = [];
  const push: PushPayload[] = [];
  const n = buildNotifier({
    send: async (text) => { telegram.push(text); return { ok: true, detail: null }; },
    sendPush: async (p) => { push.push(p); },
  });
  await settleBlocked(n);
  expect(telegram).toHaveLength(1);
  expect(push).toEqual([{ name: "api-refactor", state: "blocked", agentId: "w1:p1" }]);
});

test("the push payload carries no task line", async () => {
  // `a.task` is terminal_title_stripped — agent-authored text that may carry a
  // pasted credential — and a notification renders on a lock screen.
  const push: Record<string, unknown>[] = [];
  const n = buildNotifier({ sendPush: async (p) => { push.push(p as unknown as Record<string, unknown>); } });
  await settleBlocked(n, { task: "export AWS_SECRET=hunter2" });
  expect(Object.keys(push[0]!).sort()).toEqual(["agentId", "name", "state"]);
  expect(JSON.stringify(push[0])).not.toContain("hunter2");
});

test("a failing telegram does not suppress push", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    send: async () => { throw new Error("telegram down"); },
    sendPush: async (p) => { push.push(p); },
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});

test("a refused telegram does not suppress push either", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    send: async () => ({ ok: false, detail: "chat not found" }),
    sendPush: async (p) => { push.push(p); },
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});

test("a failing push does not suppress telegram, and never escapes", async () => {
  const telegram: string[] = [];
  const n = buildNotifier({
    send: async (text) => { telegram.push(text); return { ok: true, detail: null }; },
    sendPush: async () => { throw new Error("push down"); },
  });
  // Must not reject: a transport failure can never reach the delta path.
  await settleBlocked(n);
  expect(telegram).toHaveLength(1);
});

test("with no push sender configured, nothing changes", async () => {
  const telegram: string[] = [];
  const n = buildNotifier({
    send: async (t) => { telegram.push(t); return { ok: true, detail: null }; },
  });
  await settleBlocked(n);
  expect(telegram).toHaveLength(1);
});
