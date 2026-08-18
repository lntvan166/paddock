import { expect, test } from "bun:test";
import { Notifier, inQuietHours } from "@server/notify/notifier";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;
const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
  task: "Extract auth middleware", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", stateSince: NOW,
  updatedAt: NOW, acknowledgedAt: null, ...over,
});

interface HarnessOpts {
  /** Merged into `notify`, so a test names only the field it cares about. */
  notify?: Partial<{
    enabled: boolean; triggers: string[];
    quietHours: { start: string; end: string } | null; cooldownMs: number;
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
  let result = { ok: true, detail: null as string | null };
  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555", ...o.telegram },
      notify: {
        enabled: true, triggers: ["blocked"], quietHours: null, cooldownMs: 60_000,
        ...o.notify,
      },
      publicUrl: o.publicUrl === undefined ? "https://paddock.example.com" : o.publicUrl,
    }),
  };
  let now = o.now ?? NOW;
  const n = new Notifier({
    settings: store as never,
    send: async (text: string) => {
      if (o.throwOnSend !== undefined) throw new Error(o.throwOnSend);
      sent.push(text);
      return result;
    },
    now: () => now,
  });
  return { n, sent, setNow: (t: number) => { now = t; },
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
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toContain("api-refactor");
  expect(h.sent[0]).toContain("blocked");
  expect(h.sent[0]).toContain("https://paddock.example.com/#/agent/w1%3Ap1");
});

test("staying in the same state does not notify again", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked", task: "new output" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
});

test("a failed send does NOT consume the transition, so the next delta retries", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.fail("Bad Request: chat not found");
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
  expect(h.n.lastError).toContain("chat not found");

  h.setNow(NOW + 120_000);   // past the cooldown
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(2);
});

test("a sustained failure does not send once per delta — cooldown arms on the attempt, not the success", async () => {
  // A broken token fails every send. Without the cooldown arming on the
  // ATTEMPT (not just success), the reverted `lastSeen` would keep
  // re-detecting the transition and each of these deltas — arriving as a
  // blocked agent's task line keeps updating — would fire its own POST.
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

test("an intervening same-state delta inside the cooldown window does not permanently swallow the retry", async () => {
  // The cooldown must bound retry FREQUENCY, not consume the transition. A
  // failed send followed by a same-state delta still inside the cooldown
  // window (the ordinary case — a blocked agent's task line keeps updating)
  // must still leave a retry available once the cooldown has actually
  // elapsed. Without this test, a fix that reverts `lastSeen` only on the
  // failed-send path but not on the cooldown-suppressed path would pass the
  // "does NOT consume the transition" test above (which has no intervening
  // delta) while still permanently losing the retry in the real timeline.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.fail("Bad Request: chat not found");
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);

  // Intervening delta: same state, new task text, still inside the 60s
  // cooldown window (now has not been advanced).
  h.n.observe({ upserted: [agent({ state: "blocked", task: "still blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);   // still suppressed by the cooldown

  // Now past the cooldown: the retry must still fire.
  h.setNow(NOW + 120_000);
  h.n.observe({ upserted: [agent({ state: "blocked", task: "still blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(2);
});

test("quiet hours wrap past midnight — 22:00-08:00 is the ordinary case", () => {
  // Read naively as start <= t < end, the most common setting silences nothing.
  const qh = { start: "22:00", end: "08:00" };
  expect(inQuietHours(new Date("2026-08-18T23:30:00"), qh)).toBe(true);
  expect(inQuietHours(new Date("2026-08-18T03:00:00"), qh)).toBe(true);
  expect(inQuietHours(new Date("2026-08-18T12:00:00"), qh)).toBe(false);
  expect(inQuietHours(new Date("2026-08-18T12:00:00"), { start: "09:00", end: "17:00" })).toBe(true);
});

test("a trailing slash on publicUrl does not produce a double slash in the link", async () => {
  const sent: string[] = [];
  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: { enabled: true, triggers: ["blocked"], quietHours: null, cooldownMs: 60_000 },
      publicUrl: "https://paddock.example.com/",
    }),
  };
  const n = new Notifier({
    settings: store as never,
    send: async (text: string) => { sent.push(text); return { ok: true, detail: null }; },
    now: () => NOW,
  });
  n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("https://paddock.example.com/#/agent/w1%3Ap1");
  expect(sent[0]).not.toContain("//#/agent");
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

test("quiet hours DROP the notification, they never defer it", async () => {
  // A queue delivers a pile at 08:00 about agents unblocked five hours
  // earlier — noise wearing the costume of signal. Asserted at the Notifier
  // level, not just on the pure `inQuietHours`: the drop is only real if the
  // transition is also CONSUMED, so that a later delta in the same state
  // does not fire the moment the window passes.
  const inWindow = new Date(2026, 7, 18, 23, 30).getTime();   // 23:30 local
  const afterWindow = new Date(2026, 7, 19, 12, 0).getTime(); // 12:00 local
  const h = harness({ notify: { quietHours: { start: "22:00", end: "08:00" } }, now: inWindow });

  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toEqual([]);

  // The window has passed and the agent is still blocked. A DEFERRED
  // notification fires here; a DROPPED one never does.
  h.setNow(afterWindow);
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toEqual([]);

  // Proof the notifier is not simply mute: a genuine new transition after the
  // window still notifies.
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
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
