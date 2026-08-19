import { expect, test } from "bun:test";
import { mkdtemp, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SETTLE_MS, migrate, MIN_COOLDOWN_MS, SettingsStore,
} from "@server/settings/store";

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

test("an empty-string token from the environment is NOT configured", async () => {
  // `export PADDOCK_TELEGRAM_TOKEN=` (or a `.env` line with nothing after
  // the `=`) seeds an empty string, not an absent value. Four call sites used
  // to disagree about whether that counts as configured, which had the view
  // reporting `false` while the notifier fired against it — see
  // `isConfigured`'s comment in settings/store.ts. One predicate now answers
  // for all of them.
  const s = new SettingsStore(await dir(), {
    PADDOCK_TELEGRAM_TOKEN: "", PADDOCK_TELEGRAM_CHAT_ID: "555",
  });
  await s.load();
  expect(s.view().telegram.configured).toBe(false);
  expect(s.view().telegram.hint).toBe(null);
});

test("current() hands back a snapshot, so a caller cannot mutate the store through it", async () => {
  // Returning `#s` by reference made `const before = store.current()` an
  // ALIAS: `expect(store.current()).toEqual(before)` then compared an object
  // to itself and passed no matter what happened in between, which silently
  // defanged three route tests. Asserted here at the store, where the
  // property belongs, as well as being relied on there.
  const s = new SettingsStore(await dir(), {});
  await s.load();
  const snapshot = s.current();
  snapshot.notify.enabled = true;
  snapshot.notify.triggers.push("done");
  snapshot.telegram.token = "tampered";
  expect(s.current().notify.enabled).toBe(false);
  expect(s.current().notify.triggers).toEqual(["blocked"]);
  expect(s.current().telegram.token).toBe(null);
});

test("persist fsyncs the temp file before renaming it over settings.json", async () => {
  // The design specifies "Write `settings.json.tmp`, `fsync`, then
  // `rename()`", and gives the reason: `rename()` is atomic for the DIRECTORY
  // ENTRY and says nothing about the file's contents having reached the disk,
  // so without the sync a crash can leave the rename durable while the data
  // behind it is not — and the value lost is the token, the one field the
  // operator cannot regenerate from the UI.
  //
  // Spied on `FileHandle.prototype` rather than by mocking `node:fs/promises`:
  // Bun runs every test file in one process, so a module mock would follow
  // this suite into every file that runs after it. Every handle shares one
  // prototype, so a spy installed here sees the store's own handle — and is
  // restored immediately after, for the same reason.
  const d = await dir();
  const probe = await open(join(d, "sync-probe"), "w");
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();

  const order: string[] = [];
  const realSync = proto.sync;
  proto.sync = async function spySync(this: unknown) {
    order.push("sync");
    return (realSync as () => Promise<void>).call(this);
  };
  try {
    const s = new SettingsStore(d, {});
    await s.load();
    await s.patch({ telegram: { token: "123456:ABCDEF" } });
  } finally {
    proto.sync = realSync;
  }

  expect(order).toContain("sync");
  // And the rename still happened, so the sync did not replace the write.
  expect(JSON.parse(await readFile(join(d, "settings.json"), "utf8")).telegram.token)
    .toBe("123456:ABCDEF");
});

test("no .tmp file is left behind after a save", async () => {
  // The tmp file is the crash-safety mechanism, not an artifact: one left in
  // `~/.config/paddock` at mode 0600 is a second copy of the token nobody is
  // watching.
  const d = await dir();
  const s = new SettingsStore(d, {});
  await s.load();
  await s.patch({ telegram: { token: "123456:ABCDEF" } });
  expect((await readdir(d)).sort()).toEqual(["settings.json"]);
});

test("a v1 file gains settleMs defaults instead of loading without them", async () => {
  // A shallow `{...defaults(), ...parsed}` merge replaces `notify` wholesale,
  // so a v1 file would arrive with no settleMs at all — and `setTimeout`
  // coerces undefined to 0, silently restoring the edge-firing bug this
  // whole change exists to remove. A missing window must never mean "fire
  // immediately".
  const d = await dir();
  await writeFile(join(d, "settings.json"), JSON.stringify({
    version: 1,
    telegram: { token: "1:A", chatId: "555" },
    notify: { enabled: true, triggers: ["blocked"], quietHours: { start: "22:00", end: "08:00" }, cooldownMs: 60_000 },
    publicUrl: null,
  }));
  const s = new SettingsStore(d, {});
  await s.load();
  const cur = s.current();
  expect(cur.version).toBe(2);
  expect(cur.notify.settleMs).toEqual({ blocked: 5_000, done: 10_000 });
  expect(cur.notify.mutedUntil).toBeNull();
  expect("quietHours" in cur.notify).toBe(false);
  // The operator's real settings survive the migration.
  expect(cur.telegram.token).toBe("1:A");
  expect(cur.notify.enabled).toBe(true);
});

test("migrating a v1 file rewrites it once, so disk matches the code that reads it", async () => {
  const d = await dir();
  await writeFile(join(d, "settings.json"), JSON.stringify({ version: 1, notify: { cooldownMs: 5_000 } }));
  const s = new SettingsStore(d, {});
  await s.load();
  const onDisk = JSON.parse(await readFile(join(d, "settings.json"), "utf8"));
  expect(onDisk.version).toBe(2);
  expect(onDisk.notify.settleMs.done).toBe(10_000);
  expect(onDisk.notify.cooldownMs).toBe(5_000);
});

test("a discarded quiet-hours window is named, never dropped silently", async () => {
  const logged: string[] = [];
  migrate({ version: 1, notify: { quietHours: { start: "22:00", end: "08:00" } } }, (m) => logged.push(m));
  expect(logged.join(" ")).toContain("22:00");
  expect(logged.join(" ")).toContain("Mute");
});

test("a corrupted trigger name is named, never dropped silently", async () => {
  // Same standing rule as the quiet-hours discard above ("never swallow an
  // error"): dropping a value that is not a real NotifyTrigger is the right
  // recovery, but doing it with no trace is not.
  const logged: string[] = [];
  const s = migrate({ version: 1, notify: { triggers: ["blocked", "not-a-trigger"] } }, (m) => logged.push(m));
  expect(s.notify.triggers).toEqual(["blocked"]);
  expect(logged.join(" ")).toContain("not-a-trigger");
});

test("a v2 file is not rewritten on load", async () => {
  // Persisting on every load would rewrite settings.json — and the token
  // inside it — on every boot, for no reason.
  const d = await dir();
  const path = join(d, "settings.json");
  await writeFile(path, JSON.stringify({
    version: 2, telegram: { token: null, chatId: null },
    notify: { enabled: false, triggers: ["blocked"], settleMs: { blocked: 5_000, done: 10_000 },
              mutedUntil: null, cooldownMs: 60_000 },
    publicUrl: null,
  }));
  const before = (await stat(path)).mtimeMs;
  const s = new SettingsStore(d, {});
  await s.load();
  expect((await stat(path)).mtimeMs).toBe(before);
});

test("view() reports the server's own clock so the UI can render a countdown", async () => {
  const s = new SettingsStore(await dir(), {});
  await s.load();
  expect(s.view(1_700_000_000_000).serverNow).toBe(1_700_000_000_000);
});

test("an out-of-range settleMs or cooldownMs is corrected, and the correction is named", async () => {
  // `migrate()` validated PRESENCE but not RANGE, so a hand-edited file was a
  // second door to the two failures it exists to close: a negative settleMs
  // restores edge-firing (setTimeout treats it as 0), and cooldownMs 0 disarms
  // the per-agent rate limit that bounds a failing send. The PUT route refuses
  // both; a text editor does not go through the PUT route.
  const logged: string[] = [];
  const s = migrate(
    { version: 2, notify: { settleMs: { blocked: -5, done: 9_000_000 }, cooldownMs: 0 } },
    (m) => logged.push(m),
  );
  expect(s.notify.settleMs.blocked).toBe(0);
  expect(s.notify.settleMs.done).toBe(MAX_SETTLE_MS);
  expect(s.notify.cooldownMs).toBe(MIN_COOLDOWN_MS);
  // Named, not silently corrected — the same rule as the quiet-hours discard.
  const all = logged.join(" ");
  expect(all).toContain("settleMs.blocked");
  expect(all).toContain("settleMs.done");
  expect(all).toContain("cooldownMs");
});

test("an in-range settleMs and cooldownMs are left exactly alone, and nothing is logged", async () => {
  // The other half: a clamp that silently rewrote legal values, or logged on
  // every boot, would be its own defect.
  const logged: string[] = [];
  const s = migrate(
    { version: 2, notify: { settleMs: { blocked: 0, done: MAX_SETTLE_MS }, cooldownMs: MIN_COOLDOWN_MS } },
    (m) => logged.push(m),
  );
  expect(s.notify.settleMs).toEqual({ blocked: 0, done: MAX_SETTLE_MS });
  expect(s.notify.cooldownMs).toBe(MIN_COOLDOWN_MS);
  expect(logged).toEqual([]);
});
