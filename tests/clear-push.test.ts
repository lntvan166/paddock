import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Notifier } from "@server/notify/notifier";
import type { Agent } from "@shared/types";

/**
 * EXPERIMENT: a push that closes a notification instead of showing one.
 *
 * The reported case: a push says an agent is blocked, the operator solves it on
 * the laptop and never picks up the phone, and the alert goes on saying
 * "blocked" forever. `sweep()` cannot help — it runs in the page, and with
 * paddock closed nothing of ours is alive on that device. A push is the only
 * lever left.
 *
 * OFF by default. It worked once on a real iPhone and then push stopped
 * delivering entirely in the same session — no alert for any agent, with
 * clears already disabled, while the subscription stayed present and every
 * send kept reporting success. That is what a penalised subscription looks
 * like, and `userVisibleOnly: true` exists to enforce exactly that penalty.
 *
 * These tests still matter, because the path remains behind
 * `PADDOCK_CLEAR_PUSH=1`. The gate they pin — never clear a notification that
 * was not actually shown — is the safety mechanism, not tidiness: every clear
 * spends a breach, and one spent on a notification nobody saw buys nothing.
 */

type Sent = {
  name: string; state: string; agentId: string;
  skipDeviceKeys: Set<string>; clear?: boolean;
};

/** The same shape `tests/notifier.test.ts` uses, plus the experiment flag. */
function harness(clearPush: boolean, over: { settleMs?: Record<string, number>; replaceStale?: boolean } = {}) {
  const sent: Sent[] = [];
  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: {
        telegram: false, triggers: ["blocked", "done"],
        settleMs: over.settleMs ?? { blocked: 0, done: 0 }, mutedUntil: null, cooldownMs: 0,
      },
      publicUrl: "https://paddock.example.com",
      push: { enabled: true },
    }),
  };
  const n = new Notifier({
    settings: store as never,
    clearPush,
    replaceStale: over.replaceStale ?? false,
    send: async () => ({ ok: true, detail: null }),
    sendPush: async (p: Sent) => { sent.push(p); },
  } as never);
  return { n, sent };
}

const at = (state: Agent["state"]): Agent =>
  ({ agentId: "w1:p1", name: "api-refactor", state } as Agent);

const see = (n: Notifier, state: Agent["state"]) =>
  n.observe({ upserted: [at(state)], removedIds: [] } as never);

test("leaving blocked sends a clear, once the experiment is on", async () => {
  // settleMs is 0 in this harness, so the alert really is announced before the
  // agent moves on — which is what earns the clear.
  const { sent, n } = harness(true);
  // First sight never notifies — paddock cannot tell "just blocked" from
  // "blocked an hour ago" — so the agent has to be seen somewhere else first.
  see(n, "working");
  see(n, "blocked");
  await Bun.sleep(20);
  expect(sent.filter((s) => s.clear !== true).length, "no alert was announced").toBe(1);

  see(n, "working");
  await Bun.sleep(20);
  const clears = sent.filter((s) => s.clear === true);
  expect(clears.length, "no clear was sent when the agent left blocked").toBe(1);
  expect(clears[0]!.agentId).toBe("w1:p1");
});

test("a trigger that never got announced is never cleared", async () => {
  // Reported from the live run, and the reason this gate exists at all: a
  // trigger ARMS a timer and waits out its settle window. An agent that
  // finishes and starts again inside that window leaves `done` having shown
  // nothing — and the first version of this experiment still fired a clear,
  // closing a notification that had never existed.
  //
  // It is not merely wasted work. Every clear deliberately breaches
  // `userVisibleOnly: true`, the penalty for breaches is cumulative, and
  // spending them on notifications nobody saw is the fastest way to lose the
  // subscription for no benefit at all.
  const { sent, n } = harness(true, { settleMs: { blocked: 60_000, done: 60_000 } });
  see(n, "done");        // arms a 60s timer — nothing is announced
  see(n, "working");     // leaves the trigger well inside the window
  await Bun.sleep(20);
  expect(sent.filter((s) => s.clear !== true), "an alert escaped the settle window").toEqual([]);
  expect(
    sent.filter((s) => s.clear === true),
    "cleared a notification that was never shown",
  ).toEqual([]);
});

test("with the switch off, nothing is sent", async () => {
  // `PADDOCK_CLEAR_PUSH=0`. The escape hatch has to actually work: if push
  // ever goes quiet on a device, this is the only way back.
  const { sent, n } = harness(false);
  see(n, "working");
  see(n, "blocked");
  await Bun.sleep(20);
  see(n, "working");
  await Bun.sleep(20);
  expect(sent.filter((s) => s.clear === true)).toEqual([]);
});

test("a move between two ordinary states clears nothing", async () => {
  // working → idle never had a notification, so a clear for it would be a
  // contract breach spent on nothing at all.
  const { sent, n } = harness(true);
  see(n, "working");
  see(n, "idle");
  await Bun.sleep(20);
  expect(sent.filter((s) => s.clear === true)).toEqual([]);
});

test("a clear reaches every device, including the one showing it", async () => {
  // The single easiest thing to get wrong here. `skipDeviceKeys` exists to
  // withhold an ALERT from a device already showing that agent — which is
  // exactly the device holding the notification that has to go. Reusing the
  // alert's suppression would skip the only phone that needs telling, and
  // nothing would look broken: the push would send, succeed, and change
  // nothing.
  const { sent, n } = harness(true);
  see(n, "working");
  see(n, "blocked");
  await Bun.sleep(20);
  see(n, "working");
  await Bun.sleep(20);
  const clear = sent.find((s) => s.clear === true);
  expect(clear, "no clear sent").toBeDefined();
  expect(clear!.skipDeviceKeys.size, "a clear withheld itself from a device").toBe(0);
});

/**
 * `sw.js` behaviour is driven properly in `tests/sw.test.ts`, which loads the
 * real worker against a faked global. Only the one thing that file cannot see
 * is asserted here: that the ordinary alert path still renders at all. If it
 * ever stopped, push would be silently dead and nothing else would say so.
 */
const sw = readFileSync("public/sw.js", "utf8");



test("an ordinary alert still shows a notification", () => {
  // The contract is broken ONLY on the clear path. If a normal alert ever
  // stopped rendering, push would be silently dead and nothing else would say
  // so.
  expect(sw).toContain("self.registration.showNotification(title");
});


/**
 * The replacement path — what shipped instead of clearing.
 *
 * Same trigger, same gate, but it SHOWS the new state over the stale entry
 * rather than showing nothing. That is the whole difference: every push here
 * renders a notification, so `userVisibleOnly: true` is honoured and the
 * penalty that appeared to cost a live subscription cannot apply.
 */

test("leaving a trigger replaces the stale notification", async () => {
  const { sent, n } = harness(false, { replaceStale: true });
  see(n, "working");
  see(n, "blocked");
  await Bun.sleep(20);
  see(n, "working");
  await Bun.sleep(20);

  const after = sent[sent.length - 1]!;
  expect(after.state, "the replacement does not carry the new state").toBe("working");
  expect(after.agentId, "a replacement must reuse the tag, or it stacks").toBe("w1:p1");
  expect(after.clear, "a replacement must not take the render-nothing path").toBeUndefined();
});

test("nothing was shown, nothing is replaced", async () => {
  // The same gate the clear path needed, for a cheaper reason: a replacement
  // with no stale entry to overwrite is just an unsolicited notification.
  const { sent, n } = harness(false, {
    replaceStale: true, settleMs: { blocked: 60_000, done: 60_000 },
  });
  see(n, "idle");
  see(n, "done");      // arms a 60s timer — nothing is announced
  see(n, "working");
  await Bun.sleep(20);
  expect(sent, "sent an unsolicited notification for an alert nobody saw").toEqual([]);
});

test("clearing and replacing are never both sent", async () => {
  // Two pushes for one transition would show the new state and then close it,
  // or the reverse depending on arrival order — a race with no right answer.
  const { sent, n } = harness(true, { replaceStale: true });
  see(n, "working");
  see(n, "blocked");
  await Bun.sleep(20);
  const before = sent.length;
  see(n, "working");
  await Bun.sleep(20);
  expect(sent.length - before, "one transition produced two follow-up pushes").toBe(1);
  expect(sent[sent.length - 1]!.clear, "clearPush should win when explicitly on").toBe(true);
});



