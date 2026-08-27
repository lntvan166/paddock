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
 * This is gated and default-off because it breaks the `userVisibleOnly: true`
 * contract every subscription is made under. These tests pin the gate, the
 * trigger condition, and the one difference from an alert that is easy to get
 * wrong and impossible to notice.
 */

type Sent = {
  name: string; state: string; agentId: string;
  skipDeviceKeys: Set<string>; clear?: boolean;
};

/** The same shape `tests/notifier.test.ts` uses, plus the experiment flag. */
function harness(clearPush: boolean) {
  const sent: Sent[] = [];
  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: {
        telegram: false, triggers: ["blocked", "done"],
        settleMs: { blocked: 0, done: 0 }, mutedUntil: null, cooldownMs: 0,
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
  const { sent, n } = harness(true);
  see(n, "blocked");
  see(n, "working");
  await Bun.sleep(20);
  const clears = sent.filter((s) => s.clear === true);
  expect(clears.length, "no clear was sent when the agent left blocked").toBe(1);
  expect(clears[0]!.agentId).toBe("w1:p1");
});

test("with the experiment off, nothing is sent", async () => {
  // The default. A push that renders nothing is a contract breach, so it must
  // take a deliberate act to enable — never a code path that drifts on.
  const { sent, n } = harness(false);
  see(n, "blocked");
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
  see(n, "blocked");
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
