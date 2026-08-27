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
 * On by default since it was measured working on a real iPhone, with
 * `PADDOCK_CLEAR_PUSH=0` as the way out. It still breaks the
 * `userVisibleOnly: true` contract every subscription is made under, and the
 * penalty for that is cumulative — so these tests pin the gate that stops a
 * clear being spent on a notification nobody ever saw, which is the safety
 * mechanism rather than mere tidiness.
 */

type Sent = {
  name: string; state: string; agentId: string;
  skipDeviceKeys: Set<string>; clear?: boolean;
};

/** The same shape `tests/notifier.test.ts` uses, plus the experiment flag. */
function harness(clearPush: boolean, over: { settleMs?: Record<string, number> } = {}) {
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
 * `sw.js` is plain JavaScript served as-is, so it has no type checking and no
 * import graph a test can reach. These read the source, which is crude but is
 * the only guard available on the half of this experiment that runs on the
 * phone.
 */
const sw = readFileSync("public/sw.js", "utf8");

test("the worker closes by tag on a clear, and shows nothing", () => {
  expect(sw).toContain("payload.clear === true");
  expect(sw).toContain("getNotifications({ tag: agentId })");
  const clearBranch = sw.slice(sw.indexOf("payload.clear === true"), sw.indexOf("showNotification"));
  expect(clearBranch, "the clear branch falls through into showing a notification")
    .toContain("return;");
});

test("an untagged clear is ignored rather than guessed at", () => {
  // With no tag there is nothing to identify. Closing everything would throw
  // away alerts this push knows nothing about — and sw.js already falls back
  // to an empty tag when it cannot read a payload.
  const clearBranch = sw.slice(sw.indexOf("payload.clear === true"), sw.indexOf("showNotification"));
  expect(clearBranch).toContain('agentId === ""');
});

test("an ordinary alert still shows a notification", () => {
  // The contract is broken ONLY on the clear path. If a normal alert ever
  // stopped rendering, push would be silently dead and nothing else would say
  // so.
  expect(sw).toContain("self.registration.showNotification(title");
});
