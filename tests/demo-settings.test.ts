import { expect, test } from "bun:test";
import { installDemoBackend } from "@web/demo/backend";

// The demo is the ONLY sanctioned source of screenshots (CLAUDE.md), so any
// screen it cannot render is a screen that can never appear in the README.
test("the demo answers the settings screen's own requests", async () => {
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
});

test("the demo never invents a Telegram token", async () => {
  // A demo that shipped a token-shaped string would put one in every
  // screenshot, and check-private.sh scans for exactly that shape.
  installDemoBackend();
  const view = await (await fetch("/api/settings")).json();
  expect(view.telegram.configured).toBe(false);
  expect(view.telegram.hint).toBeNull();
  expect(JSON.stringify(view)).not.toMatch(/\d{8,}:[A-Za-z0-9_-]{30,}/);
});
