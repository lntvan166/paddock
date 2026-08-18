import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "@server/settings/store";

const dir = async () => mkdtemp(join(tmpdir(), "paddock-settings-"));

test("defaults when no file exists, and notifications start off", async () => {
  const s = new SettingsStore(await dir(), {});
  await s.load();
  expect(s.current().notify.enabled).toBe(false);
  expect(s.view().telegram.configured).toBe(false);
});

test("the token is never present in the view, only a hint", async () => {
  const s = new SettingsStore(await dir(), {});
  await s.load();
  await s.patch({ telegram: { token: "123456:ABCDEF-secret-7f21" } });
  const v = s.view();
  expect(JSON.stringify(v)).not.toContain("secret");
  expect(v.telegram).toEqual({ configured: true, hint: "7f21", chatId: null });
});

test("the settings file is written 0600 — it holds a bearer credential", async () => {
  const d = await dir();
  const s = new SettingsStore(d, {});
  await s.load();
  await s.patch({ telegram: { token: "123456:ABCDEF" } });
  expect((await stat(join(d, "settings.json"))).mode & 0o777).toBe(0o600);
});

test("a malformed file does NOT erase the token: defaults in memory, error surfaced, no overwrite", async () => {
  // Overwriting a corrupt file with defaults destroys the one value the
  // operator cannot regenerate from the UI.
  const d = await dir();
  await writeFile(join(d, "settings.json"), "{ not json");
  const s = new SettingsStore(d, {});
  await s.load();
  expect(s.error).toContain("settings.json");
  expect(s.current().notify.enabled).toBe(false);
  expect(await readFile(join(d, "settings.json"), "utf8")).toBe("{ not json");
});

test("environment seeds the FIRST run only, never overriding a saved value", async () => {
  const d = await dir();
  const s = new SettingsStore(d, { PADDOCK_TELEGRAM_CHAT_ID: "555" });
  await s.load();
  expect(s.view().telegram.chatId).toBe("555");

  await s.patch({ telegram: { chatId: "777" } });
  const again = new SettingsStore(d, { PADDOCK_TELEGRAM_CHAT_ID: "555" });
  await again.load();
  expect(again.view().telegram.chatId).toBe("777");
});
