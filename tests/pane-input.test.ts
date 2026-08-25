import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { SpaceTree } from "@shared/types";

// ── POST /api/panes/:id/text, POST /api/panes/:id/key ───────────────────────
// Built with injected fakes, same convention as tests/spaces-route.test.ts and
// tests/pane-read.test.ts — no server is started and the operator's real
// herdr is never touched.

const NOW = 1_700_000_000_000;

const TREE: SpaceTree = {
  readAt: NOW,
  spaces: [{
    spaceId: "w1", label: "example-space", tabCount: 1, paneCount: 2,
    tabs: [{
      tabId: "w1:t1", label: null,
      panes: [
        { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "api-refactor", cwd: "/srv/project", state: "working" },
        { paneId: "w1:p2", harness: null, name: null, title: null, cwd: "/srv/project", state: null },
      ],
    }],
  }],
};

/** Same ceiling as `MAX_TEXT_LEN` in `src/server/routes.ts` — not exported,
 *  so mirrored here rather than reached into. */
const MAX_TEXT_LEN = 10_000;

function harness(
  readTree?: () => Promise<SpaceTree>,
  overrides: { sendPaneText?: (paneId: string, text: string) => Promise<void>;
               sendPaneKey?: (paneId: string, key: string) => Promise<void> } = {},
) {
  const calls: string[] = [];
  return {
    app: createApp({
      store: new AgentStore("dev-box"),
      hub: new Hub({ now: () => NOW }),
      now: () => NOW,
      readTree,
      actions: {
        async readOutput() { return { lines: [], source: "visible" as const }; },
        async readPane() { return { lines: [], source: "recent_unwrapped" as const }; },
        async readDetection() { return ""; },
        async sendOptionKey() {},
        async sendNavKey() {},
        async sendReply() {},
        async sendPaneText(paneId: string, text: string) {
          calls.push(`text:${paneId}:${text}`);
          if (overrides.sendPaneText) await overrides.sendPaneText(paneId, text);
        },
        async sendPaneKey(paneId: string, key: string) {
          calls.push(`key:${paneId}:${key}`);
          if (overrides.sendPaneKey) await overrides.sendPaneKey(paneId, key);
        },
        async waitUntilUnblocked() {},
      },
      health: () => ({
        ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: true, lastEventAt: NOW,
        lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null,
        schemaWarning: null,
      }),
    }),
    calls,
  };
}

const post = (app: any, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ── /text ────────────────────────────────────────────────────────────────

test("text reaches sendPaneText verbatim", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p2/text", { text: "ls -la\n" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toEqual(["text:w1:p2:ls -la\n"]);
});

test("text over the length ceiling is refused, not truncated", async () => {
  const { app, calls } = harness(async () => TREE);
  const tooLong = "a".repeat(MAX_TEXT_LEN + 1);
  const res = await post(app, "/api/panes/w1:p2/text", { text: tooLong });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("empty text is refused", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p2/text", { text: "   " });
  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a pane with an agent gets 409, pointing at the agent route, for /text", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p1/text", { text: "hello" });
  expect(res.status).toBe(409);
  expect((await res.json()).detail).toContain("/api/agents/:id/text");
  expect(calls).toEqual([]);
});

test("an unknown pane 404s, distinctly from a herdr failure, for /text", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/nope/text", { text: "hello" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown pane");
  expect(calls).toEqual([]);
});

test("without a herdr reader /text 404s honestly, like /api/panes/:id/output in demo mode", async () => {
  const { app, calls } = harness(undefined);
  const res = await post(app, "/api/panes/w1:p2/text", { text: "hello" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
  expect(calls).toEqual([]);
});

test("a herdr throw from sendPaneText becomes ok:false/502, with the message in detail", async () => {
  const { app, calls } = harness(async () => TREE, {
    sendPaneText: async () => { throw new Error("pane_not_found"); },
  });
  const res = await post(app, "/api/panes/w1:p2/text", { text: "hello" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("pane_not_found");
  expect(calls).toEqual(["text:w1:p2:hello"]);
});

test("a readTree throw from /text becomes ok:false/502, never a bare 500", async () => {
  const { app, calls } = harness(async () => { throw new Error("herdr socket refused"); });
  const res = await post(app, "/api/panes/w1:p2/text", { text: "hello" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("herdr socket refused");
  expect(calls).toEqual([]);
});

// ── /key ─────────────────────────────────────────────────────────────────

test("an allowlisted key reaches sendPaneKey", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p2/key", { key: "enter" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toEqual(["key:w1:p2:enter"]);
});

test("a key outside the allowlist is refused 400 and never forwarded", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p2/key", { key: "C-c" });
  expect(res.status).toBe(400);
  expect((await res.json()).detail).toContain("C-c");
  expect(calls).toEqual([]);
});

test("a pane with an agent gets 409, pointing at the agent route, for /key", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/w1:p1/key", { key: "enter" });
  expect(res.status).toBe(409);
  expect((await res.json()).detail).toContain("/api/agents/:id/key");
  expect(calls).toEqual([]);
});

test("an unknown pane 404s for /key", async () => {
  const { app, calls } = harness(async () => TREE);
  const res = await post(app, "/api/panes/nope/key", { key: "enter" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toBe("unknown pane");
  expect(calls).toEqual([]);
});

test("without a herdr reader /key 404s honestly", async () => {
  const { app, calls } = harness(undefined);
  const res = await post(app, "/api/panes/w1:p2/key", { key: "enter" });
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
  expect(calls).toEqual([]);
});

test("a herdr throw from sendPaneKey becomes ok:false/502, with the message in detail", async () => {
  const { app, calls } = harness(async () => TREE, {
    sendPaneKey: async () => { throw new Error("pane_not_found"); },
  });
  const res = await post(app, "/api/panes/w1:p2/key", { key: "enter" });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("pane_not_found");
  expect(calls).toEqual(["key:w1:p2:enter"]);
});
