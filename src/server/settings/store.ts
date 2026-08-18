import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

  current(): Settings { return this.#s; }

  view(): SettingsView {
    const t = this.#s.telegram.token;
    return {
      telegram: {
        configured: t !== null && t !== "",
        hint: t ? t.slice(-4) : null,
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

  /** Atomic: a crash midway through a direct overwrite truncates the file, and
   *  the value lost is the token — the one field the UI cannot regenerate. */
  private async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#s, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }
}
