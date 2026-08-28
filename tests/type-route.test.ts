import { expect, test } from "bun:test";
import type { Agent } from "@shared/types";
import { typeIntoDialog } from "@web/api";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

const ESC = String.fromCharCode(27);

/** A dialog with the cursor already on the free-text row. */
const READY = [
  "←  ☐ Tea  ✔ Submit  →",
  "",
  "Which teas do you drink?",
  "",
  "  1. [ ] Green tea",
  "  Light and grassy, lower caffeine.",
  "❯ 2. [ ] Type something",
  "     Submit",
].join("\n");

function harness(over: Record<string, unknown> = {}) {
  const sent: string[][] = [];
  const store = new AgentStore("dev-box");
  store.replaceAll([{
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "blocked", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project", harness: "claude",
    stateSince: 0, stateSinceExact: false, updatedAt: 0, acknowledgedAt: null,
    hasJournal: false,
  } as Agent], 0);

  const app = createApp({
    store, hub: new Hub(), health: () => ({}) as never,
    actions: {
      async readPromptScreen() { return READY; },
      async sendChars(_t: string, chars: string[]) { sent.push(chars); },
      async sendNavKey() {},
      async readOutput() { return { lines: ["after"], source: "visible" }; },
      ...over,
    } as never,
  });
  return { app, sent };
}

const type = (app: ReturnType<typeof harness>["app"], text: unknown) =>
  app.request("/api/agents/w1:p1/type", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

test("text arrives as one key per code point", async () => {
  const { app, sent } = harness();

  const res = await type(app, "chào");

  expect(res.status).toBe(200);
  // Split by CODE POINT, not by byte and not by UTF-16 unit: the operator
  // writes Vietnamese, and herdr refuses a whole word as a key — measured,
  // `send_keys ["chào"]` answers `invalid_key`.
  expect(sent[0]).toEqual(["c", "h", "à", "o"]);
});

test("an astral-plane character is not cut in half", async () => {
  const { app, sent } = harness();

  await type(app, "a🌱b");

  expect(sent[0]).toEqual(["a", "🌱", "b"]);
});

test("what cannot be typed is refused, not sent on faith", async () => {
  const { app, sent } = harness();

  for (const [why, text] of [
    ["empty", ""],
    ["whitespace only", "   "],
    ["not a string", 42],
    ["a control character", `a${ESC}b`],
    ["a newline, which is Enter and not text", "a\nb"],
    ["past the ceiling", "x".repeat(1_000)],
  ] as [string, unknown][]) {
    expect((await type(app, text)).status, why).toBe(400);
  }

  expect(sent, "nothing reached the agent").toEqual([]);
});

test("the screen the typing produced comes back on the same round trip", async () => {
  // Same contract as `/text` and `/key`: settle, read, answer with the screen,
  // so the browser paints the result instead of waiting for a poll that may
  // have backed off toward ten seconds.
  const { app } = harness();

  const body = await (await type(app, "hi")).json();

  expect(body.ok).toBe(true);
  expect(body.lines).toEqual(["after"]);
});

test("a screen with no dialog on it answers 409, and types nothing", async () => {
  // 409, not 400: the request was well formed and the SCREEN was wrong, which
  // is the same distinction `/answer` already draws.
  const { app, sent } = harness({
    async readPromptScreen() { return "Do you want to proceed?\n❯ 1. Yes\n  2. No"; },
  });

  const res = await type(app, "hi");

  expect(res.status).toBe(409);
  expect((await res.json()).detail).toContain("dialog");
  expect(sent).toEqual([]);
});

test("a non-JSON answer becomes a sentence, not an engine message", async () => {
  // `res.json()` on a body that is not JSON throws an ENGINE message, and the
  // engines disagree: Safari says "SyntaxError: The string did not match the
  // expected pattern." where Chromium says "Unexpected end of JSON input".
  // That Safari string reached a phone as the whole of an error banner.
  //
  // A non-JSON body here means something structural — most likely a route that
  // is not there, which is what a cached bundle against a newer server looks
  // like — so the status is the useful part.
  const notJson = async () => new Response("404 Not Found", { status: 404 });

  const r = await typeIntoDialog("w1:p1", "hi", notJson as never);

  expect(r.ok).toBe(false);
  expect(r.detail).toContain("404");
  expect(r.detail, "no engine jargon").not.toContain("SyntaxError");
  expect(r.detail).toContain("reloading");
});

test("an empty body says so rather than throwing", async () => {
  const empty = async () => new Response("", { status: 502 });

  const r = await typeIntoDialog("w1:p1", "hi", empty as never);

  expect(r.ok).toBe(false);
  expect(r.detail).toContain("empty body");
});
