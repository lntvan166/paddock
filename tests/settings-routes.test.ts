import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/routes";
import { SettingsStore } from "@server/settings/store";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

/**
 * `sendTest` always stubbed: ruling P4 on the task brief. The real route's
 * only injection point is `AppDeps.sendTest`, so no test here may reach
 * api.telegram.org — slow, flaky, and impossible offline or in CI.
 */
async function harness(sendTest?: (o: { token: string; chatId: string; text: string }) =>
  Promise<{ ok: boolean; detail: string | null }>) {
  // `{}` explicitly, never the real `process.env` default. `.env.example`
  // tells operators to export `PADDOCK_TELEGRAM_TOKEN` and
  // `PADDOCK_TELEGRAM_CHAT_ID`, and `SettingsStore.load()` seeds a fresh
  // config from them — so on a machine where the operator has actually
  // followed the README, the store under test starts pre-configured and
  // tests that assert on the unconfigured default fail. Measured: 2 of 9
  // failed. tests/settings-store.test.ts already does this.
  const settings = new SettingsStore(await mkdtemp(join(tmpdir(), "paddock-r-")), {});
  await settings.load();
  const app = createApp({
    store: new AgentStore("dev-box"), hub: new Hub({ build: () => "test" }),
    health: () => ({ ok: true }) as never, settings,
    sendTest: sendTest ?? (async () => ({ ok: true, detail: null })),
  });
  return { app, settings };
}

test("GET never returns the token, only configured and a hint", async () => {
  const { app, settings } = await harness();
  await settings.patch({ telegram: { token: "123456:ABCDEF-secret-7f21" } });
  const res = await app.request("/api/settings");
  const text = await res.text();
  expect(res.status).toBe(200);
  expect(text).not.toContain("secret");
  expect(JSON.parse(text).telegram).toEqual({ configured: true, hint: "7f21", chatId: null });
});

test("PUT accepts a patch and persists it", async () => {
  const { app, settings } = await harness();
  const res = await app.request("/api/settings", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ notify: { enabled: true, triggers: ["blocked", "done"] } }),
  });
  expect(res.status).toBe(200);
  expect(settings.current().notify.triggers).toEqual(["blocked", "done"]);
});

test("the test route reports Telegram's own description so the operator can fix it", async () => {
  const { app, settings } = await harness(async () => ({ ok: false, detail: "chat not found" }));
  await settings.patch({ telegram: { token: "1:A", chatId: "bad" } });
  const res = await app.request("/api/settings/telegram/test", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(typeof body.detail).toBe("string");
});

test("the test route refuses when nothing is configured, rather than reporting a silent success", async () => {
  const { app } = await harness();
  const res = await app.request("/api/settings/telegram/test", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  expect(res.status).toBe(400);
});

test("a failed patch returns 500 with the reason, never a silent success", async () => {
  const { app, settings } = await harness();
  // The failure is injected by replacing `settings.patch` with one that
  // throws — NOT by breaking anything on disk. What is under test here is the
  // route's handling of a rejected patch (500 with the reason, never a
  // silently swallowed error reported as success), so the cheapest rejection
  // that reaches that handler is the right one. `original` is restored at the
  // end because `settings` is shared with nothing else in this test, but a
  // leaked stub would be a nasty thing to debug.
  const original = settings.patch.bind(settings);
  settings.patch = async () => {
    throw new Error("disk full");
  };
  const res = await app.request("/api/settings", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicUrl: "https://paddock.example.com" }),
  });
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("disk full");
  settings.patch = original;
});

test("a malformed JSON PUT body returns 400 with a reason, not a generic 500", async () => {
  const { app } = await harness();
  const res = await app.request("/api/settings", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(typeof body.detail).toBe("string");
});

test("a wrong-typed notify.triggers is rejected and leaves stored settings unchanged", async () => {
  const { app, settings } = await harness();
  const before = settings.current();
  const res = await app.request("/api/settings", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ notify: { triggers: "nope" } }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(settings.current()).toEqual(before);
});

test("a wrong-typed telegram.token is rejected and leaves stored settings unchanged", async () => {
  const { app, settings } = await harness();
  const before = settings.current();
  const res = await app.request("/api/settings", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram: { token: 12345 } }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(settings.current()).toEqual(before);
});

test("cooldownMs: 0 is rejected — it would disarm the cooldown and reintroduce the retry hot loop", async () => {
  const { app, settings } = await harness();
  const before = settings.current();
  const res = await app.request("/api/settings", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ notify: { cooldownMs: 0 } }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(settings.current()).toEqual(before);
});
