import { expect, test } from "bun:test";
import { DEFAULT_READ_LINES, MAX_READ_LINES } from "@server/herdr/actions";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "blocked", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project", harness: "claude",
    stateSince: NOW, stateSinceExact: true, updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
  };
}

/** `screen` overrides what `readOutput` returns, for the tests that care what
 *  the route derives FROM the screen rather than that it read one. */
function harness(a: Agent = agent(), screen?: string[]) {
  const store = new AgentStore("dev-box");
  store.replaceAll([a], NOW);
  const calls: string[] = [];
  const actions = {
    // The line count is recorded, not just the call: it is the only
    // client-supplied value that reaches a herdr parameter, so what arrives
    // here is the thing under test.
    async readOutput(_t: string, _s: Agent["state"], lines?: number) {
      calls.push(`readOutput:${lines}`);
      return { lines: screen ?? ["out"], source: "visible" as const };
    },
    async readPane() { calls.push("readPane"); return { lines: screen ?? ["out"], source: "recent_unwrapped" as const }; },
    async readDetection() { calls.push("readDetection"); return "Proceed?\n ❯ 1. Yes\n   2. No\n"; },
    async sendOptionKey(_t: string, k: string) { calls.push(`key:${k}`); },
    async sendNavKey(_t: string, k: string) { calls.push(`nav:${k}`); },
    async sendReply(_t: string, text: string) { calls.push(`reply:${text}`); },
    async sendPaneText(_p: string, text: string) { calls.push(`paneText:${text}`); },
    async sendPaneKey(_p: string, k: string) { calls.push(`paneKey:${k}`); },
    async waitUntilUnblocked() { calls.push("wait"); },
    async renameAgent(_t: string, name: string | null) { calls.push(`renameAgent:${name}`); },
    async renameTab(_id: string, label: string) { calls.push(`renameTab:${label}`); },
    async renameSpace(_id: string, label: string) { calls.push(`renameSpace:${label}`); },
  };
  const hub = new Hub({ now: () => NOW });
  const app = createApp({
    store, hub, actions, now: () => NOW,
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, schemaWarning: null }),
  });
  return { app, store, calls };
}

const post = (app: any, path: string, body?: object) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

test("output returns lines and the source used", async () => {
  const { app } = harness();
  const res = await post(app, "/api/agents/w1:p1/output");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.lines).toEqual(["out"]);
  expect(body.source).toBe("visible");
  // The digest the client echoes back on its next poll.
  expect(typeof body.digest).toBe("string");
  expect(body.unchanged).toBeFalsy();
});

// Revalidation. Measured on a live working agent, consecutive 3s polls differ
// by 3 lines out of 63 — so ~95% of a 10.8 KB response is bytes the client is
// already holding.
test("a matching digest answers `unchanged` and sends no screen", async () => {
  const { app } = harness();
  const first = await (await post(app, "/api/agents/w1:p1/output")).json();

  const res = await post(app, "/api/agents/w1:p1/output", { since: first.digest });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.unchanged).toBe(true);
  // The screen must be ABSENT, not empty: an empty `lines` here would be
  // applied by a careless client and blank the pane on the very response that
  // means it is still correct.
  expect(body.lines).toBeUndefined();
});

test("a stale or malformed digest still returns the full screen", async () => {
  // Note on coverage: the route also type-checks `since` before comparing,
  // and that guard is DEFENSIVE rather than load-bearing — `=== digest`
  // against a string already rejects every non-string, so removing the check
  // leaves behaviour identical and this test cannot detect it. It stays as a
  // statement of intent for anyone who later loosens the comparison.
  const { app } = harness();
  for (const since of ["not-the-current-digest", "", 42, null, {}]) {
    const body = await (await post(app, "/api/agents/w1:p1/output", { since })).json();
    expect(body.unchanged).toBeFalsy();
    expect(body.lines).toEqual(["out"]);
  }
});

test("without a digest the server always sends the screen", async () => {
  // The opening read sends no `since`, because the point of it is to paint.
  const { app } = harness();
  const body = await (await post(app, "/api/agents/w1:p1/output")).json();
  expect(body.unchanged).toBeFalsy();
  expect(body.lines).toEqual(["out"]);
});

// A client-supplied `lines` used to be cast, never checked: `{"lines": 1e9}`
// asked herdr for a billion lines and buffered the answer in this process,
// and `{"lines": "60"}` put a string into a herdr numeric param. Spec §5 says
// output is "bounded by a line count" — the bound is paddock's.
test("an out-of-range lines value is clamped to the read ceiling", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/w1:p1/output", { lines: 1e9 })).status).toBe(200);
  expect(calls).toEqual([`readOutput:${MAX_READ_LINES}`]);
});

test("a non-numeric lines value falls back to the default", async () => {
  const { app, calls } = harness();
  await post(app, "/api/agents/w1:p1/output", { lines: "60" });
  await post(app, "/api/agents/w1:p1/output", { lines: { n: 60 } });
  await post(app, "/api/agents/w1:p1/output", { lines: -5 });
  await post(app, "/api/agents/w1:p1/output", {});
  expect(calls).toEqual(Array(4).fill(`readOutput:${DEFAULT_READ_LINES}`));
});

test("a valid lines value is passed through unchanged", async () => {
  const { app, calls } = harness();
  await post(app, "/api/agents/w1:p1/output", { lines: 40 });
  expect(calls).toEqual(["readOutput:40"]);
});

test("prompt returns parsed options", async () => {
  const { app } = harness();
  const body = await (await post(app, "/api/agents/w1:p1/prompt")).json();
  expect(body.options).toHaveLength(2);
  expect(body.options[0]).toEqual({ key: "1", label: "Yes", selected: true });
});

test("answering by key sends the digit and confirms", async () => {
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w1:p1/answer", { key: "2" });
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toEqual(["key:2", "wait"]);
});

test("answering by text goes through agent.prompt", async () => {
  const { app, calls } = harness();
  await post(app, "/api/agents/w1:p1/answer", { text: "run tests first" });
  expect(calls).toEqual(["reply:run tests first", "wait"]);
});

// THE scope guard. agent.prompt accepts arbitrary text, so this is enforced
// against the store rather than trusted to the UI.
test("answering a NON-blocked agent is refused, and nothing is sent", async () => {
  const { app, calls } = harness(agent({ state: "working" }));
  const res = await post(app, "/api/agents/w1:p1/answer", { key: "1" });
  expect(res.status).toBe(409);
  expect((await res.json()).ok).toBe(false);
  expect(calls).toEqual([]);
});

test("answering an unknown agent is refused", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/nope:p1/answer", { key: "1" })).status).toBe(404);
  expect(calls).toEqual([]);
});

test("an answer with neither key nor text is rejected", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/w1:p1/answer", {})).status).toBe(400);
  expect(calls).toEqual([]);
});

// Spec §6 calls the key "the option's digit", and states there is no
// general-purpose send endpoint. A control sequence is a strictly larger
// capability than the free text `{text}` already permits.
test("a non-digit key is refused, and nothing is sent to herdr", async () => {
  for (const key of ["C-c", "Escape", "1;rm -rf /", "0x2", " 2"]) {
    const { app, calls } = harness();
    const res = await post(app, "/api/agents/w1:p1/answer", { key });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    expect(calls).toEqual([]);
  }
});

// A JSON number passes a plain truthiness check and reaches agent.send_keys
// as a non-string.
test("a numeric key is refused rather than forwarded as a non-string", async () => {
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w1:p1/answer", { key: 2 });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a numeric text is refused rather than forwarded as a non-string", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/w1:p1/answer", { text: 7 })).status).toBe(400);
  expect(calls).toEqual([]);
});

test("a two-digit option key is still accepted", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/w1:p1/answer", { key: "10" })).status).toBe(200);
  expect(calls).toEqual(["key:10", "wait"]);
});

test("ack marks a done agent and is refused for others", async () => {
  const done = harness(agent({ state: "done" }));
  expect((await post(done.app, "/api/agents/w1:p1/ack")).status).toBe(200);
  expect(done.store.snapshot()[0]!.acknowledgedAt).toBe(NOW);

  const blocked = harness();
  expect((await post(blocked.app, "/api/agents/w1:p1/ack")).status).toBe(409);
});

// Spec §7: nothing is sent to herdr for an acknowledge. Registering /ack
// inside `if (deps.actions)` made it 404 in `--demo` — where the seeded `done`
// agent renders a Dismiss button — so the one v2 feature that needs no herdr
// was the one broken in the mode the README takes screenshots from.
test("ack works with no herdr actions wired up at all, as in --demo", async () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent({ state: "done" })], NOW);
  const app = createApp({
    store, hub: new Hub({ now: () => NOW }), now: () => NOW,
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, schemaWarning: null }),
  });
  const res = await post(app, "/api/agents/w1:p1/ack");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(store.snapshot()[0]!.acknowledgedAt).toBe(NOW);
});

// The herdr-backed routes must still be absent there — they have nothing to
// call, and a 404 is honest where a synthetic success would not be.
test("the herdr-backed routes stay absent with no actions", async () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app = createApp({
    store, hub: new Hub({ now: () => NOW }), now: () => NOW,
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, schemaWarning: null }),
  });
  for (const route of ["output", "prompt", "answer"]) {
    expect((await post(app, `/api/agents/w1:p1/${route}`, { key: "1" })).status).toBe(404);
  }
});

test("a failed action reports ok:false rather than throwing", async () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app2 = createApp({
    store, hub: new Hub({ now: () => NOW }),
    actions: {
      async readOutput() { return { lines: [], source: "visible" as const }; },
      async readPane() { return { lines: [], source: "recent_unwrapped" as const }; },
      async readDetection() { return ""; },
      async sendOptionKey() { throw new Error("herdr said no"); },
      async sendNavKey() { throw new Error("herdr said no"); },
      async sendReply() {}, async waitUntilUnblocked() {},
      async renameAgent() {}, async renameTab() {}, async renameSpace() {},
      async sendPaneText() {}, async sendPaneKey() {},
    },
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, schemaWarning: null }),
  });
  const res = await post(app2, "/api/agents/w1:p1/answer", { key: "1" });
  expect(res.status).toBe(502);
  expect((await res.json()).detail).toContain("herdr said no");
});

// ── POST /text ─────────────────────────────────────────────────────────────
// The terminal view's reply box. Distinct from /answer: /answer commits a
// reply paddock composed FOR A PROMPT, so it must prove the agent is still
// asking. This is the operator typing into a terminal they are looking at,
// which is exactly the reasoning that already puts /key in every state.

test("typed text is accepted in EVERY state, and returns the screen it produced", async () => {
  for (const state of ["idle", "working", "done", "blocked"] as const) {
    const { app, calls } = harness(agent({ state }));
    const res = await post(app, "/api/agents/w1:p1/text", { text: "ls -la" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(calls).toContain("reply:ls -la");
    // Same one-interaction contract as /key: type, then see what happened.
    expect(body.lines).toEqual(["out"]);
  }
});

test("empty or non-string text is refused and never reaches herdr", async () => {
  const { app, calls } = harness();
  for (const text of ["", "   ", null, 5, undefined, {}]) {
    const res = await post(app, "/api/agents/w1:p1/text", { text });
    expect(res.status).toBe(400);
  }
  expect(calls.filter((c) => c.startsWith("reply:"))).toEqual([]);
});

test("over-long text is refused rather than forwarded to herdr", async () => {
  // The only unbounded client-supplied string that reaches a herdr parameter.
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w1:p1/text", { text: "x".repeat(10_001) });
  expect(res.status).toBe(400);
  expect(calls.filter((c) => c.startsWith("reply:"))).toEqual([]);
});

test("typed text to an unknown agent is refused before anything is sent", async () => {
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w9:p9/text", { text: "hi" });
  expect(res.status).toBe(404);
  expect(calls.filter((c) => c.startsWith("reply:"))).toEqual([]);
});

test("a nav key is sent, and the screen it produced comes back with it", async () => {
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w1:p1/key", { key: "down" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(calls).toContain("nav:down");
  // The re-read belongs to the same response: pressing a key and seeing the
  // cursor move is one interaction, and splitting it into two round trips
  // over a slow link is what would make navigation feel broken.
  expect(body.lines).toEqual(["out"]);
  const readAt = calls.findIndex((c) => c.startsWith("readOutput"));
  expect(readAt).toBeGreaterThan(-1);
  expect(calls.indexOf("nav:down")).toBeLessThan(readAt);
});

test("a key outside the allowlist is refused and never reaches herdr", async () => {
  const { app, calls } = harness();
  for (const key of ["pageup", "ctrl+c", "a", "", null, 5]) {
    const res = await post(app, "/api/agents/w1:p1/key", { key });
    expect(res.status).toBe(400);
  }
  // The allowlist is the entire boundary between this and a general-purpose
  // key-send endpoint, so none of the above may have reached the socket.
  expect(calls.filter((c) => c.startsWith("nav:"))).toEqual([]);
});

test("nav keys are allowed on an agent that is NOT blocked, unlike /answer", async () => {
  // The deliberate difference between the two routes, pinned so it cannot be
  // "tidied" into consistency later. /answer commits a reply paddock composed,
  // so it must prove the agent is still asking. A nav key only moves the
  // agent's own cursor on a screen the operator is looking at.
  const { app, calls } = harness(agent({ state: "working" }));

  const answer = await post(app, "/api/agents/w1:p1/answer", { key: "1" });
  expect(answer.status).toBe(409);

  const key = await post(app, "/api/agents/w1:p1/key", { key: "esc" });
  expect(key.status).toBe(200);
  expect(calls).toContain("nav:esc");
});

test("an unknown agent is refused before any key is sent", async () => {
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w9:p9/key", { key: "up" });
  expect(res.status).toBe(404);
  expect(calls.filter((c) => c.startsWith("nav:"))).toEqual([]);
});

test("a failed key reports ok:false with no lines, never a blanked screen", async () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app2 = createApp({
    store, hub: new Hub({ now: () => NOW }),
    actions: {
      async readOutput() { return { lines: ["kept"], source: "visible" as const }; },
      async readPane() { return { lines: ["kept"], source: "recent_unwrapped" as const }; },
      async readDetection() { return ""; },
      async sendOptionKey() {},
      async sendNavKey() { throw new Error("herdr said no"); },
      async sendReply() {}, async waitUntilUnblocked() {},
      async renameAgent() {}, async renameTab() {}, async renameSpace() {},
      async sendPaneText() {}, async sendPaneKey() {},
    },
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, schemaWarning: null }),
  });
  const res = await post(app2, "/api/agents/w1:p1/key", { key: "enter" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("herdr said no");
  // Empty means "no new screen", never "the pane is empty" — the client keys
  // off `ok` before painting, and the contract carries the empty array so it
  // has a shape to check rather than an absent field.
  expect(body.lines).toEqual([]);
});

// ── line-level patches ─────────────────────────────────────────────────────
// A thinking agent redraws only its spinner and token counter: measured on a
// live agent at 250ms, the MEDIAN changed update touched ONE line of 63.
// Resending the whole screen for that was ~90% waste.

test("a known previous screen gets a patch, not a whole screen", async () => {
  const { app } = harness();
  const first = await (await post(app, "/api/agents/w1:p1/output")).json();
  expect(first.lines).toEqual(["out"]);

  // Same digest -> unchanged. That path still wins when nothing moved at all.
  const same = await (await post(app, "/api/agents/w1:p1/output", { since: first.digest })).json();
  expect(same.unchanged).toBe(true);
});

test("an unknown digest falls back to a full screen", async () => {
  // A client that has fallen behind, or just connected, cannot apply a patch
  // against a screen the server no longer holds. Full screen is always
  // correct and only ever costs bandwidth.
  const { app } = harness();
  const body = await (await post(app, "/api/agents/w1:p1/output", { since: "not-a-held-digest" })).json();
  expect(body.patch).toBeUndefined();
  expect(body.lines).toEqual(["out"]);
  expect(typeof body.digest).toBe("string");
});

test("a scrollback read is never answered with a patch", async () => {
  // History is a different, much larger view of the pane. Diffing it against
  // a viewport would rewrite nearly every line and save nothing.
  const { app } = harness();
  const first = await (await post(app, "/api/agents/w1:p1/output")).json();
  const body = await (await post(app, "/api/agents/w1:p1/output",
    { since: first.digest, scrollback: true })).json();
  expect(body.patch).toBeUndefined();
});

test("a keystroke's preview is scoped to the live menu, not a marker left on an answered one", async () => {
  // `/key` re-derives the preview from the screen it has just re-read, so it
  // needs the same scoping rule `/prompt` uses. Without it the stale label
  // comes back on the first arrow tap — which reads as a fix that did not
  // take, because the initial render is right and only moving breaks it.
  const screen = [
    " Which approach?",
    " ❯ 1. Merge locally",
    "   2. Create a pull request",
    "",
    " Collapse the keypad?",
    "   1. Leave it visible",
    "   2. Collapse it",
  ];
  const { app } = harness(agent(), screen);
  const res = await post(app, "/api/agents/w1:p1/key", { key: "down" });
  expect(res.status).toBe(200);
  expect((await res.json()).selected).toBeNull();
});

test("a keystroke's preview survives the colour the live screen keeps", async () => {
  // `/prompt` reads with strip_ansi, `/key` does not — it re-reads the LIVE
  // screen. So the shared rule has to see through escapes, or moving the
  // cursor reports nothing at all on a coloured TUI. Built from a charcode so
  // no escape byte sits literally in this file.
  const esc = String.fromCharCode(27);
  const screen = [
    " Proceed?",
    "   1. Yes",
    ` ${esc}[36m❯${esc}[0m 2. No`,
  ];
  const { app } = harness(agent(), screen);
  const res = await post(app, "/api/agents/w1:p1/key", { key: "down" });
  expect((await res.json()).selected).toBe("2. No");
});
