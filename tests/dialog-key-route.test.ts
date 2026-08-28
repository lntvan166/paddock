import { expect, test } from "bun:test";
import type { Agent } from "@shared/types";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

/**
 * The route a dialog option's digit goes through, and why it is not `/answer`.
 *
 * `/answer` calls `waitUntilUnblocked` after sending, because it commits a reply
 * and the agent is expected to move on. A dialog digit never unblocks anything:
 * measured, a multi-select digit toggles a checkbox and a single-select digit
 * only advances to the review tab — the agent stays `blocked` until "Submit
 * answers". Sent through `/answer`, every checkbox tap would wait out the whole
 * 15s budget and then report a failure for a toggle that worked.
 */

const DIALOG = [
  "←  ☐ Tea  ✔ Submit  →",
  "",
  "Which teas do you drink?",
  "",
  "❯ 1. [✔] Green tea",
  "  Light and grassy, lower caffeine.",
  "  2. [ ] Type something",
  "     Submit",
].join("\n");

function harness(state: Agent["state"] = "blocked") {
  const sent: string[] = [];
  let waited = false;
  const store = new AgentStore("dev-box");
  store.replaceAll([{
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor", task: "Extract auth middleware",
    state, workspaceId: "w1", workspaceLabel: "api work", cwd: "/srv/project",
    harness: "claude", stateSince: 0, stateSinceExact: false, updatedAt: 0,
    acknowledgedAt: null, hasJournal: false,
  }], 0);

  const app = createApp({
    store, hub: new Hub(), health: () => ({}) as never,
    actions: {
      // The route reads before it sends now: a digit is only a toggle while the
      // cursor is off the free-text row, and here it is on option 1.
      async readPromptScreen() { return DIALOG; },
      async sendNavKey() {},
      async sendOptionKey(_t: string, k: string) { sent.push(k); },
      async readOutput() { return { lines: DIALOG.split("\n"), source: "visible" }; },
      async waitUntilUnblocked() { waited = true; },
    } as never,
  });
  return { app, sent, didWait: () => waited };
}

const tap = (app: ReturnType<typeof harness>["app"], key: unknown) =>
  app.request("/api/agents/w1:p1/dialog-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });

test("the digit is sent, and nothing waits for the agent to move on", async () => {
  const { app, sent, didWait } = harness();

  const res = await tap(app, "2");

  expect(res.status).toBe(200);
  expect(sent).toEqual(["2"]);
  expect(didWait(), "waiting here would hang every checkbox tap for 15s").toBe(false);
});

test("the screen and a fresh dialog come back on the same round trip", async () => {
  // This is what keeps a checkbox honest. `/prompt` is fetched once per state
  // change and never polled, so without the dialog in this response the mark on
  // screen would lag the agent until the next state change.
  const { app } = harness();

  const body = await (await tap(app, "1")).json();

  expect(body.ok).toBe(true);
  expect(body.lines.length).toBeGreaterThan(0);
  expect(body.dialog).not.toBeNull();
  expect(body.dialog.options[0].checked).toBe(true);
  expect(body.dialog.mode).toBe("multi");
});

test("only an option digit is accepted", async () => {
  const { app, sent } = harness();

  for (const [why, key] of [
    ["a letter", "a"],
    ["a control key name", "enter"],
    ["empty", ""],
    ["not a string", 2],
    ["zero, which no option is", "0"],
  ] as [string, unknown][]) {
    expect((await tap(app, key)).status, why).toBe(400);
  }

  expect(sent, "nothing reached the agent").toEqual([]);
});

test("an agent that is no longer blocked has no dialog to answer", async () => {
  // Same guard as `/answer`, same reason: the dialog is gone, and a digit typed
  // into whatever replaced it is a keystroke the operator did not ask for.
  const { app, sent } = harness("working");

  const res = await tap(app, "1");

  expect(res.status).toBe(409);
  expect(sent).toEqual([]);
});

/** The multi-select question, with the cursor wherever `cursorOn` says. */
function dialogScreen(cursorOn: string) {
  const mark = (row: string) => (row === cursorOn ? "❯" : " ");
  return [
    "←  ☐ Tea  ☐ Coffee  ✔ Submit  →",
    "",
    "Which teas do you drink?",
    "",
    `${mark("1")} 1. [✔] Green tea`,
    "  Light and grassy, lower caffeine.",
    `${mark("2")} 2. [ ] Type something`,
    `${mark("advance")}    Next`,
  ].join("\n");
}

/** The dialog's OTHER question, to prove the move actually landed. */
function otherQuestion() {
  return [
    "←  ☒ Tea  ☐ Coffee  ✔ Submit  →",
    "",
    "How strong do you like your tea?",
    "",
    "❯ 1. Light",
    "     Short steep.",
    "  2. Strong",
    "     Long steep.",
  ].join("\n");
}

function advanceHarness(reads: string[]) {
  const keys: string[] = [];
  const store = new AgentStore("dev-box");
  store.replaceAll([{
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "blocked", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project", harness: "claude",
    stateSince: 0, stateSinceExact: false, updatedAt: 0, acknowledgedAt: null,
    hasJournal: false,
  } as Agent], 0);

  let i = 0;
  const app = createApp({
    store, hub: new Hub(), health: () => ({}) as never,
    actions: {
      async readPromptScreen() { return reads[Math.min(i++, reads.length - 1)]!; },
      async sendNavKey(_t: string, k: string) { keys.push(k); },
      async sendChars() {},
      async readOutput() { return { lines: dialogScreen("advance").split("\n"), source: "visible" }; },
    } as never,
  });
  return { app, keys };
}

const moveTab = (app: ReturnType<typeof advanceHarness>["app"], dir: string) =>
  app.request("/api/agents/w1:p1/dialog-tab", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir }),
  });

test("a tab move waits for the screen before answering", async () => {
  // The repaint lands on the second look. Answering after the first would hand
  // the UI the previous question — the "sometimes not work" the arrows were
  // reported with.
  const { app, keys } = advanceHarness([
    dialogScreen("1"), dialogScreen("1"), otherQuestion(),
  ]);

  const body = await (await moveTab(app, "right")).json();

  expect(body.ok).toBe(true);
  expect(keys).toEqual(["right"]);
  expect(body.dialog.question).toBe("How strong do you like your tea?");
});

test("only left or right", async () => {
  const { app, keys } = advanceHarness([dialogScreen("1")]);

  for (const dir of ["up", "", "enter", 3]) {
    expect((await moveTab(app, dir as string)).status, String(dir)).toBe(400);
  }
  expect(keys).toEqual([]);
});

test("a nav key answers with the re-parsed dialog", async () => {
  // The other half of "cannot jump to next tab": the arrow worked, but nothing
  // in the response told the UI the question had changed.
  const { app } = advanceHarness([dialogScreen("1")]);

  const body = await (await app.request("/api/agents/w1:p1/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "right" }),
  })).json();

  expect(body.ok).toBe(true);
  expect(body.dialog).not.toBeNull();
  expect(body.dialog.question).toBe("Which teas do you drink?");
});
