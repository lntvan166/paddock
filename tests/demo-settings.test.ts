import { expect, test } from "bun:test";
import { installDemoBackend } from "@web/demo/backend";

// `installDemoBackend` mutates globals Bun shares across every test file in
// this process (see tests/demo.test.ts's comment on the same fact), so each
// test here must save and restore `fetch`/`WebSocket` itself — a leaked stub
// `fetch` would break an unrelated test that never asked for one, and would
// also poison the "original fetch" that tests/settings-load-failure.test.tsx
// captures and restores to.

// The demo is the ONLY sanctioned source of screenshots (CLAUDE.md), so any
// screen it cannot render is a screen that can never appear in the README.
test("the demo answers the settings screen's own requests", async () => {
  const savedFetch = globalThis.fetch;
  const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  try {
    installDemoBackend();

    const settings = await fetch("/api/settings");
    expect(settings.ok).toBe(true);
    const view = await settings.json();
    // The fields Settings.tsx reads on load. A stub missing any one of them
    // reproduces the blank screen this task exists to fix.
    expect(view.telegram).toBeDefined();
    expect(view.notify).toBeDefined();
    expect(view.notify.settleMs).toBeDefined();
    expect(typeof view.serverNow).toBe("number");

    const health = await fetch("/api/health");
    expect(health.ok).toBe(true);
    const body = await health.json();
    expect(typeof body.version).toBe("string");
    expect(typeof body.herdrConnected).toBe("boolean");
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  }
});

test("the demo never invents a Telegram token", async () => {
  // A demo that shipped a token-shaped string would put one in every
  // screenshot, and check-private.sh scans for exactly that shape.
  const savedFetch = globalThis.fetch;
  const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  try {
    installDemoBackend();
    const view = await (await fetch("/api/settings")).json();
    expect(view.telegram.configured).toBe(false);
    expect(view.telegram.hint).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/\d{8,}:[A-Za-z0-9_-]{30,}/);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  }
});

test("the sub-routes are not swallowed by the settings route", async () => {
  // "/api/settings" is a prefix of both. A substring match answered the test
  // button with a settings view, which rendered as an empty error banner.
  const savedFetch = globalThis.fetch;
  const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  try {
    installDemoBackend();

    const test = await (await fetch("/api/settings/telegram/test", { method: "POST" })).json();
    expect(typeof test.ok).toBe("boolean");
    expect(typeof test.detail).toBe("string");

    const muted = await (await fetch("/api/settings/mute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ forMs: 3_600_000 }),
    })).json();
    expect(typeof muted.notify.mutedUntil).toBe("number");
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  }
});
