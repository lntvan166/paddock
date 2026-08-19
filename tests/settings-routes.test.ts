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
async function harness(
  sendTest?: (o: { token: string; chatId: string; text: string }) =>
    Promise<{ ok: boolean; detail: string | null }>,
  now?: () => number,
) {
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
    health: () => ({
      ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: true,
      lastEventAt: null, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null,
    }),
    settings,
    sendTest: sendTest ?? (async () => ({ ok: true, detail: null })),
    now,
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

test("a token containing a slash is refused, because it would redirect the API path", async () => {
  // sendTelegram builds api.telegram.org/bot${token}/sendMessage — the token
  // is interpolated into a URL PATH, so "1:A/../getUpdates" addresses a
  // different Telegram method than this code intends.
  const { app } = await harness();
  const res = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram: { token: "1:A/../getUpdates" } }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.detail).toContain("telegram.token");
  // The rejected value must never come back out.
  expect(JSON.stringify(body)).not.toContain("getUpdates");
});

test("a well-formed token is accepted", async () => {
  const { app } = await harness();
  const res = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram: { token: "123456:AAHfake-Token_value" } }),
  });
  expect(res.status).toBe(200);
});

test("clearing the token with null is still allowed", async () => {
  const { app } = await harness();
  const res = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram: { token: null } }),
  });
  expect(res.status).toBe(200);
});

test("clearing the token with an empty string is still allowed", async () => {
  // isConfigured treats "" the same as null (see its doc comment: four call
  // sites once disagreed on this and produced a live retry loop). The
  // `tt.token !== ""` exemption in validateSettingsPatch must let this
  // through rather than running it against isTokenShape.
  const { app } = await harness();
  const res = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telegram: { token: "" } }),
  });
  expect(res.status).toBe(200);
});

test("the test route sends with the credentials in the body, not the stored ones", async () => {
  // The operator pastes a token and presses "Send test message" — the only
  // order that lets them find out whether it works BEFORE committing it.
  // Reading settings.current() answered "token and chat id must both be set".
  const calls: { token: string; chatId: string; text: string }[] = [];
  const { app } = await harness(async (o) => { calls.push(o); return { ok: true, detail: null }; });
  const res = await app.request("/api/settings/telegram/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "999:BBtyped", chatId: "777" }),
  });
  expect(res.status).toBe(200);
  expect(calls.map((c) => ({ token: c.token, chatId: c.chatId })))
    .toEqual([{ token: "999:BBtyped", chatId: "777" }]);
});

test("a blank field falls back to the stored value, per field", async () => {
  const calls: { token: string; chatId: string; text: string }[] = [];
  const { app, settings } = await harness(async (o) => { calls.push(o); return { ok: true, detail: null }; });
  await settings.patch({ telegram: { token: "1:A", chatId: "555" } });
  const res = await app.request("/api/settings/telegram/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId: "777" }),
  });
  expect(res.status).toBe(200);
  expect(calls.map((c) => ({ token: c.token, chatId: c.chatId })))
    .toEqual([{ token: "1:A", chatId: "777" }]);
});

test("an explicit empty-string token in the body falls back to the stored token, per field", async () => {
  // Distinct from "a blank field falls back...", which omits the field
  // entirely. Here the body sends token: "" outright, exercising the
  // isConfigured("") branch of `pick` rather than the `typeof typed ===
  // "string"` branch failing on `undefined`. A differing stored chat id
  // proves resolution still happens per field, not all-or-nothing.
  const calls: { token: string; chatId: string; text: string }[] = [];
  const { app, settings } = await harness(async (o) => { calls.push(o); return { ok: true, detail: null }; });
  await settings.patch({ telegram: { token: "1:A", chatId: "555" } });
  const res = await app.request("/api/settings/telegram/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "", chatId: "777" }),
  });
  expect(res.status).toBe(200);
  expect(calls.map((c) => ({ token: c.token, chatId: c.chatId })))
    .toEqual([{ token: "1:A", chatId: "777" }]);
});

test("an empty body still tests the stored credentials", async () => {
  const calls: { token: string; chatId: string; text: string }[] = [];
  const { app, settings } = await harness(async (o) => { calls.push(o); return { ok: true, detail: null }; });
  await settings.patch({ telegram: { token: "1:A", chatId: "555" } });
  const res = await app.request("/api/settings/telegram/test", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  expect(res.status).toBe(200);
  expect(calls.map((c) => ({ token: c.token, chatId: c.chatId })))
    .toEqual([{ token: "1:A", chatId: "555" }]);
});

test("400 when neither the body nor the store supplies a credential", async () => {
  // A fresh store starts with both null (harness passes `{}` for env), so
  // nothing needs clearing here.
  const { app } = await harness();
  const res = await app.request("/api/settings/telegram/test", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  expect(res.status).toBe(400);
});

test("a malformed token in the body is refused before any request is made", async () => {
  let called = false;
  const { app } = await harness(async () => { called = true; return { ok: true, detail: null }; });
  const res = await app.request("/api/settings/telegram/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "1:A/../getUpdates", chatId: "777" }),
  });
  expect(res.status).toBe(400);
  expect(called).toBe(false);
});

test("a successful test does not save the credentials", async () => {
  // A probe is not a commit. The sticky save bar keeps saying "Unsaved
  // changes", so a green test cannot be mistaken for one.
  const { app, settings } = await harness(async () => ({ ok: true, detail: null }));
  await settings.patch({ telegram: { token: "1:A", chatId: "555" } });
  await app.request("/api/settings/telegram/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "999:BBtyped", chatId: "777" }),
  });
  expect(settings.current().telegram.token).toBe("1:A");
  expect(settings.current().telegram.chatId).toBe("555");
});

const MAX_MUTE_MS = 7 * 24 * 60 * 60 * 1000;

test("mute stamps an instant from the server's clock, not the client's", async () => {
  // The client sends a DURATION. A phone with a skewed clock must not be able
  // to set an absolute instant — and the operator's phone and the dev-box need
  // not share a timezone or a correct clock.
  const { app, settings } = await harness(undefined, () => 1_700_000_000_000);
  const res = await app.request("/api/settings/mute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ forMs: 4 * 60 * 60 * 1000 }),
  });
  expect(res.status).toBe(200);
  expect(settings.current().notify.mutedUntil).toBe(1_700_000_000_000 + 4 * 60 * 60 * 1000);
  const body = await res.json();
  expect(body.notify.mutedUntil).toBe(1_700_000_000_000 + 4 * 60 * 60 * 1000);
  // The view carries the server's clock so the UI can render a countdown.
  expect(body.serverNow).toBe(1_700_000_000_000);
});

test("forMs 0 unmutes", async () => {
  const { app, settings } = await harness(undefined, () => 1_700_000_000_000);
  await app.request("/api/settings/mute", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ forMs: 60_000 }),
  });
  const res = await app.request("/api/settings/mute", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ forMs: 0 }),
  });
  expect(res.status).toBe(200);
  expect(settings.current().notify.mutedUntil).toBeNull();
});

test("a negative or over-long duration is refused", async () => {
  const { app } = await harness();
  for (const forMs of [-1, MAX_MUTE_MS + 1, Number.NaN, "4h"]) {
    const res = await app.request("/api/settings/mute", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ forMs }),
    });
    expect(res.status).toBe(400);
  }
});

test("mute is not reachable through the settings patch", async () => {
  // Mute must apply immediately while every other field waits for Save.
  // Making that a separate endpoint is what makes it structural.
  const { app, settings } = await harness();
  const res = await app.request("/api/settings", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ notify: { mutedUntil: 9_999_999_999_999 } }),
  });
  expect(res.status).toBe(200);            // unknown keys are ignored, not rejected
  expect(settings.current().notify.mutedUntil).toBeNull();
});
