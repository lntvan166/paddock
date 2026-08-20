import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notifier, type TimerHandle } from "@server/notify/notifier";
import { SettingsStore } from "@server/settings/store";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;
const TUNNEL = "https://quiet-harbor-8f31.trycloudflare.com";
const SAVED = "https://paddock.example.com";

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
  task: "Extract auth middleware", state: "working", workspaceId: "w1",
  workspaceLabel: "api work", cwd: "/srv/project",
  stateSince: NOW, updatedAt: NOW, acknowledgedAt: null, ...over,
});

test("the tunnel URL is used for deeplinks and never saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-tunnel-"));
  // An empty env, not process.env: a developer with PADDOCK_TELEGRAM_* set
  // would otherwise have their own token loaded into this store.
  const settings = new SettingsStore(dir, {});
  await settings.load();
  await settings.patch({
    telegram: { token: "1:aa", chatId: "9" },
    notify: { enabled: true, triggers: ["blocked"], settleMs: { blocked: 0, done: 0 } },
    publicUrl: SAVED,
  });

  const sent: unknown[] = [];
  // Timers are injected and the clock is fixed, exactly as
  // tests/notifier-settle.test.ts does it — one mechanism for driving this
  // class in a test, not two.
  let now = NOW;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;

  const notifier = new Notifier({
    settings,
    publicUrlOverride: () => TUNNEL,
    send: async (text, replyMarkup) => {
      sent.push({ text, replyMarkup });
      return { ok: true, detail: null };
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id as unknown as TimerHandle;
    },
    clearTimer: (h) => { timers.delete(h as unknown as number); },
  });

  // `observe` takes a Delta, and first sight arms nothing — paddock cannot
  // tell "just blocked" from "blocked an hour ago" — so it takes a real
  // transition to produce a message at all.
  notifier.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  notifier.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  for (const [id, t] of [...timers]) {
    if (t.at <= now) { timers.delete(id); t.fn(); }
  }
  await Bun.sleep(5); // let the fire path's await settle

  expect(JSON.stringify(sent)).toContain(TUNNEL);
  expect(JSON.stringify(sent)).not.toContain("paddock.example.com");

  // The operator's real hostname is still exactly what it was on disk.
  const onDisk = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
    publicUrl: string;
  };
  expect(onDisk.publicUrl).toBe(SAVED);
});
