import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NotifyTrigger, SettingsPatch, SettingsView } from "@shared/types";

export interface Settings {
  version: 1;
  telegram: { token: string | null; chatId: string | null };
  notify: {
    enabled: boolean;
    triggers: NotifyTrigger[];
    quietHours: { start: string; end: string } | null;
    cooldownMs: number;
  };
  publicUrl: string | null;
}

/** 60s, not minutes: working → blocked → working → blocked is a real sequence
 *  the operator wants both halves of. It guards flapping, not repetition. */
export const DEFAULT_COOLDOWN_MS = 60_000;

const defaults = (): Settings => ({
  version: 1,
  telegram: { token: null, chatId: null },
  notify: { enabled: false, triggers: ["blocked"], quietHours: null,
            cooldownMs: DEFAULT_COOLDOWN_MS },
  publicUrl: null,
});

export function defaultConfigDir(): string {
  return process.env.PADDOCK_CONFIG_DIR ?? join(homedir(), ".config", "paddock");
}

/**
 * The ONE definition of "this credential field is configured". Import it;
 * never re-derive it.
 *
 * Four call sites used to disagree — `view()` here tested `!== null && !== ""`,
 * `notifier.ts` tested `!== null`, and `index.ts` / `routes.ts` used plain
 * falsiness. With `PADDOCK_TELEGRAM_TOKEN=""` exported (which `.env.example`
 * invites an operator to set), that disagreement produced a live loop:
 * `GET /api/settings` reported `configured: false` while the notifier read the
 * empty string as present, fired the send closure, got "not configured" back,
 * reverted the transition, and re-attempted once per cooldown forever with
 * `/api/health` pinned to `lastNotifyError`. An empty string is not a
 * credential; it is the shape an unset environment variable takes.
 */
export function isConfigured(v: string | null | undefined): v is string {
  return typeof v === "string" && v !== "";
}

export class SettingsStore {
  #s: Settings = defaults();
  /** Non-null when the file exists but could not be parsed. Blocks writes
   *  until an explicit save, which is an informed overwrite. */
  error: string | null = null;

  constructor(private dir: string, private env: Record<string, string | undefined> = process.env) {}

  private get file(): string { return join(this.dir, "settings.json"); }

  async load(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      // ENOENT is the first run, and is not an error. Anything else is.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        this.error = `settings.json unreadable: ${(e as Error).message}`;
        return;
      }
    }

    if (raw === null) {
      this.#s = defaults();
      const chat = this.env.PADDOCK_TELEGRAM_CHAT_ID ?? null;
      const token = this.env.PADDOCK_TELEGRAM_TOKEN ?? null;
      if (chat !== null) this.#s.telegram.chatId = chat;
      if (token !== null) this.#s.telegram.token = token;
      if (chat !== null || token !== null) await this.persist();
      return;
    }

    try {
      this.#s = { ...defaults(), ...(JSON.parse(raw) as Settings) };
    } catch (e) {
      this.error = `settings.json is not valid JSON, using defaults and not overwriting it: ${(e as Error).message}`;
      this.#s = defaults();
    }
  }

  /**
   * A DEEP COPY, never `#s` itself.
   *
   * Returning the live object made every caller a potential mutator of the
   * store's private state, and it silently defanged three route tests:
   * `const before = settings.current()` aliased the same object, so
   * `expect(settings.current()).toEqual(before)` compared an object to itself
   * and passed even when a rejected patch had in fact been applied. Those
   * "leaves stored settings unchanged" assertions are only load-bearing if
   * this returns a snapshot. `structuredClone` rather than a spread because
   * `telegram`, `notify` and `notify.quietHours` are all nested — a shallow
   * copy would alias exactly the fields a patch writes.
   */
  current(): Settings { return structuredClone(this.#s); }

  view(): SettingsView {
    const t = this.#s.telegram.token;
    return {
      telegram: {
        configured: isConfigured(t),
        hint: isConfigured(t) ? t.slice(-4) : null,
        chatId: this.#s.telegram.chatId,
      },
      notify: { ...this.#s.notify, triggers: [...this.#s.notify.triggers] },
      publicUrl: this.#s.publicUrl,
      error: this.error,
    };
  }

  async patch(p: SettingsPatch): Promise<void> {
    if (p.telegram) this.#s.telegram = { ...this.#s.telegram, ...p.telegram };
    if (p.notify) this.#s.notify = { ...this.#s.notify, ...p.notify };
    if (p.publicUrl !== undefined) this.#s.publicUrl = p.publicUrl;
    // An explicit save clears a load fault: the operator has chosen to replace
    // whatever was unparseable.
    this.error = null;
    await this.persist();
  }

  /**
   * Atomic: a crash midway through a direct overwrite truncates the file, and
   * the value lost is the token — the one field the UI cannot regenerate.
   *
   * `fsync` before the `rename`, not merely write-then-rename. `rename()` is
   * atomic with respect to the DIRECTORY entry, but that says nothing about
   * the tmp file's CONTENTS having reached the disk: without the sync a crash
   * can leave the rename durable while the data behind it is not, which lands
   * settings.json pointing at a zero-length or partially written file — and
   * the value lost is, again, the token.
   */
  private async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(JSON.stringify(this.#s, null, 2));
      await fh.sync();
    } finally {
      // Closed on the failure path too, or a rejected write leaks the handle.
      await fh.close();
    }
    // `open`'s mode is subject to the process umask; this is not.
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }
}
