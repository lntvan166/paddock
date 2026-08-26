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
  /** Override the Telegram credentials — `{ token: "", chatId: "" }` is an
   *  operator who wants push and never set Telegram up. */
  telegram?: { token: string; chatId: string };
}) {
  const store = {
    current: () => ({
      telegram: o.telegram ?? { token: "1:A", chatId: "555" },
      notify: {
        telegram: true, triggers: ["blocked"],
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

test("push reaches a device when Telegram was never configured at all", async () => {
  // THE GAP THAT LET THE BUG SHIP. `a failing telegram does not suppress push`
  // above looks like it covers this and does not: it configures a token and
  // fails the SEND, which happens AFTER the credentials guard. An absent token
  // returns BEFORE it. Two paths, and only one of them was ever driven.
  //
  // What that cost: an operator who wanted push and not Telegram got silence,
  // with no error logged anywhere, because delivery returned before the push
  // was dispatched.
  const telegram: string[] = [];
  const push: PushPayload[] = [];
  const n = buildNotifier({
    telegram: { token: "", chatId: "" },
    send: async (text) => { telegram.push(text); return { ok: true, detail: null }; },
    sendPush: async (p) => { push.push(p); },
  });
  await settleBlocked(n);

  expect(push).toEqual([{ name: "api-refactor", state: "blocked", agentId: "w1:p1" }]);
  // And Telegram is not attempted — a transport with no credentials must not
  // be POSTed to, and must not record a failure the operator never asked for.
  expect(telegram).toHaveLength(0);
});

test("a half-configured Telegram is treated as unconfigured, and still lets push through", async () => {
  // `isConfigured` differs from `!== null` for an empty string, and an unset
  // environment variable IS an empty string — so a token with no chat id is
  // the shape a partly-filled .env produces.
  const telegram: string[] = [];
  const push: PushPayload[] = [];
  const n = buildNotifier({
    telegram: { token: "1:A", chatId: "" },
    send: async (text) => { telegram.push(text); return { ok: true, detail: null }; },
    sendPush: async (p) => { push.push(p); },
  });
  await settleBlocked(n);

  expect(push).toHaveLength(1);
  expect(telegram).toHaveLength(0);
});
