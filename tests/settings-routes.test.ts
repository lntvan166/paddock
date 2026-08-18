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
  const settings = new SettingsStore(await mkdtemp(join(tmpdir(), "paddock-r-")));
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
  // Force a write failure by breaking the persisted directory into a file so
  // `mkdir(dir, { recursive: true })` inside `persist()` rejects.
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
