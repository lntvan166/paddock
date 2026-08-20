import { expect, test } from "bun:test";
import { Notifier } from "@server/notify/notifier";
import type { Agent, InlineKeyboard } from "@shared/types";

const NOW = 1_700_000_000_000;
const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
  task: "Extract auth middleware", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", stateSince: NOW,
  updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
});

interface HarnessOpts {
  /** Merged into `notify`, so a test names only the field it cares about. */
  notify?: Partial<{
    enabled: boolean; triggers: string[];
    settleMs: { blocked: number; done: number };
    mutedUntil: number | null; cooldownMs: number;
  }>;
  telegram?: Partial<{ token: string | null; chatId: string | null }>;
  publicUrl?: string | null;
  now?: number;
  /** Makes `send` REJECT rather than resolve `{ok:false}` — the unhandled
   *  rejection path, which is a different failure from a refused send. */
  throwOnSend?: string;
}

function harness(o: HarnessOpts = {}) {
  const sent: string[] = [];
  const sentMarkup: (InlineKeyboard | undefined)[] = [];
  let result = { ok: true, detail: null as string | null };
  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555", ...o.telegram },
      notify: {
        enabled: true, triggers: ["blocked"],
        settleMs: { blocked: 0, done: 0 }, mutedUntil: null, cooldownMs: 60_000,
        ...o.notify,
      },
      publicUrl: o.publicUrl === undefined ? "https://paddock.example.com" : o.publicUrl,
    }),
  };
  let now = o.now ?? NOW;
  const n = new Notifier({
    settings: store as never,
    send: async (text: string, replyMarkup?: InlineKeyboard) => {
      if (o.throwOnSend !== undefined) throw new Error(o.throwOnSend);
      sent.push(text);
      sentMarkup.push(replyMarkup);
      return result;
    },
    now: () => now,
  });
  return { n, sent, sentMarkup, setNow: (t: number) => { now = t; },
           fail: (d: string) => { result = { ok: false, detail: d }; } };
}

test("first sight after boot does not notify", async () => {
  // Otherwise restarting paddock pings once per currently-blocked agent —
  // a burst of notifications caused by nothing having happened.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toEqual([]);
});

test("a transition into a watched state notifies, with name, state and deep link", async () => {
  // The deep link is an inline button (Task 10), not text — an https
  // publicUrl means the text carries name and state only.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toContain("api-refactor");
  expect(h.sent[0]).toContain("blocked");
  expect(h.sentMarkup[0]).toEqual({
    inline_keyboard: [[{ text: "Open in paddock", url: "https://paddock.example.com/#/agent/w1%3Ap1" }]],
  });
});

test("staying in the same state does not notify again", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked", task: "new output" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
});

test("a sustained failure does not send once per delta", async () => {
  // A broken token fails every send, and the deltas below keep arriving because
  // a blocked agent's task line keeps updating. v2 answered each of them with
  // its own Telegram POST; one send is the whole assertion here.
  //
  // What this test does NOT do is isolate WHICH guard holds that line, and the
  // honest reading is that more than one overlaps: `#see` returns early on a
  // delta that does not change state, so nothing is armed at all — and with
  // that return deleted the cooldown deferral refuses the send anyway
  // (measured: this file stays green either way). The title says only what is
  // asserted, because the original said "cooldown arms on the attempt, not the
  // success" and moving that write onto the success path also leaves this file
  // green.
  //
  // The individual mechanisms are pinned elsewhere, deliberately, in
  // tests/notifier-timing.test.ts: attempt-stamped `#lastSentAt` and the
  // deferral by "a cooldown deferral does not consume a retry attempt", and the
  // bound by "a failed send retries at the cooldown, three attempts, then
  // stops". Both drive the retry path directly, which this test does not.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.fail("Bad Request: chat not found");
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);

  // Three more deltas for the same transition, all still inside the
  // 60_000ms cooldown window and all still failing.
  h.n.observe({ upserted: [agent({ state: "blocked", task: "output A" })], removedIds: [] });
  await Bun.sleep(1);
  h.n.observe({ upserted: [agent({ state: "blocked", task: "output B" })], removedIds: [] });
  await Bun.sleep(1);
  h.n.observe({ upserted: [agent({ state: "blocked", task: "output C" })], removedIds: [] });
  await Bun.sleep(1);

  expect(h.sent).toHaveLength(1);
});

test("a trailing slash on publicUrl does not produce a double slash in the link", async () => {
  const sent: string[] = [];
  let markup: InlineKeyboard | undefined;
  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: {
        enabled: true, triggers: ["blocked"],
        settleMs: { blocked: 0, done: 0 }, mutedUntil: null, cooldownMs: 60_000,
      },
      publicUrl: "https://paddock.example.com/",
    }),
  };
  const n = new Notifier({
    settings: store as never,
    send: async (text: string, replyMarkup?: InlineKeyboard) => {
      sent.push(text); markup = replyMarkup; return { ok: true, detail: null };
    },
    now: () => NOW,
  });
  n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(sent).toHaveLength(1);
  const url = markup?.inline_keyboard[0]?.[0]?.url;
  expect(url).toBe("https://paddock.example.com/#/agent/w1%3Ap1");
  expect(url).not.toContain("//#/agent");
});

/**
 * The task line is `terminal_title_stripped` — live, agent-authored text that
 * can contain anything the agent has echoed, including a pasted credential.
 * The design's content rule is explicit: "the agent name, the new state, and
 * a deep link… Never terminal output, and never the task text, which may
 * carry pasted secrets." Telegram bot messages are not end-to-end encrypted;
 * content minimalism is the ONLY mitigation recorded for choosing Telegram
 * over Web Push, so this assertion is that mitigation, in code.
 */
const LEAKY_TASK = "paste-of-a-credential-do-not-transmit-9f21";

test("the message never carries the task text, which may hold pasted secrets", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working", task: LEAKY_TASK })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked", task: LEAKY_TASK })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).not.toContain(LEAKY_TASK);
  // And still says the two things it is supposed to say, so "send nothing at
  // all" cannot pass this test.
  expect(h.sent[0]).toContain("api-refactor");
  expect(h.sent[0]).toContain("blocked");
});

test("a send that REJECTS is recorded on lastError, never left unhandled", async () => {
  // Bun terminates the process on an unhandled rejection, and `observe`
  // deliberately does not await `#one` — so without a `.catch()` a throwing
  // send takes the whole dashboard down over a notification. Recorded rather
  // than swallowed: `lastError` is what /api/health exposes.
  const h = harness({ throwOnSend: "fetch failed: getaddrinfo ENOTFOUND" });
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.n.lastError).toContain("ENOTFOUND");
});

test("an empty-string token is not 'configured', so nothing is sent and nothing retries", async () => {
  // `PADDOCK_TELEGRAM_TOKEN=""` exported is the real case. Three different
  // definitions of "configured" had the view reporting false while the
  // notifier considered the transition fireable, calling a send closure that
  // answers "not configured", reverting, and re-attempting once per cooldown
  // forever with /api/health pinned to lastNotifyError.
  const h = harness({ telegram: { token: "" } });
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toEqual([]);
  expect(h.n.lastError).toBe(null);
});
