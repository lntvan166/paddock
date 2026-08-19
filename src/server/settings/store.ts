import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NotifyTrigger, SettingsPatch, SettingsView } from "@shared/types";

export interface Settings {
  version: 2;
  telegram: { token: string | null; chatId: string | null };
  notify: {
    enabled: boolean;
    triggers: NotifyTrigger[];
    settleMs: Record<NotifyTrigger, number>;
    mutedUntil: number | null;
    cooldownMs: number;
  };
  publicUrl: string | null;
}

/** 60s, not minutes: working → blocked → working → blocked is a real sequence
 *  the operator wants both halves of. It guards flapping, not repetition. */
export const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * `blocked` settles fast because a blocked agent is waiting on the operator
 * and every second of the window is a second of an agent doing nothing.
 * `done` settles longer because it is the state that lies: a main agent that
 * delegates goes `working → done` the moment a subagent returns, then back to
 * `working` when it reviews the result.
 *
 * 10s is a STARTING value, not a measured one. It covers a main agent that
 * resumes immediately; it does not cover one that spends 20s composing a
 * review first. Raise `done` to 30–60s if false finishes persist, and record
 * what worked in docs/settings.md.
 */
export const DEFAULT_SETTLE_MS: Record<NotifyTrigger, number> = { blocked: 5_000, done: 10_000 };

export const MAX_SETTLE_MS = 600_000;

/**
 * Floor for `notify.cooldownMs`, enforced both by the PUT route's validator and
 * by `migrate()` on load.
 *
 * Task 4 spent two fix rounds eliminating an unbounded-retry hot loop that
 * fired on every delta when a Telegram send failed; `cooldownMs: 0` disarms the
 * rate limit entirely and reintroduces exactly that loop. 1000 ms is a floor
 * against that specific failure mode, not a recommendation — the default
 * (`DEFAULT_COOLDOWN_MS`) is 60_000 ms. Do not relax this without re-reading
 * why Task 4 needed it.
 *
 * It lives here rather than in `routes.ts` because the two enforcement points
 * must not be able to disagree, and `routes.ts` may import from settings while
 * settings may not import from routes.
 */
export const MIN_COOLDOWN_MS = 1000;

const defaults = (): Settings => ({
  version: 2,
  telegram: { token: null, chatId: null },
  notify: {
    enabled: false, triggers: ["blocked"], settleMs: { ...DEFAULT_SETTLE_MS },
    mutedUntil: null, cooldownMs: DEFAULT_COOLDOWN_MS,
  },
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

/**
 * The ONE definition of "this string is shaped like a bot token".
 *
 * `sendTelegram` builds `api.telegram.org/bot${token}/sendMessage`, so the
 * token lands in a URL PATH. A token containing `/` or `..` therefore
 * addresses a different Telegram method than the call site intends. Nothing
 * validated this before — it is a pre-existing hole on the stored-token path,
 * not one the on-screen-credentials route introduces.
 *
 * Real tokens are `<digits>:<base64url-ish>`; this is deliberately a little
 * wider than that, because guessing Telegram's exact format and being wrong
 * would lock out a valid credential. It is a path-safety guard, not a format
 * checker.
 */
export function isTokenShape(v: string): boolean {
  return v.length <= 200 && /^[A-Za-z0-9:_-]+$/.test(v);
}

/**
 * The one rejection message for a shape-invalid token, shared by both call
 * sites (`validateSettingsPatch` and the test route). Names the rule, never
 * the value. Hoisted so the two 400 responses cannot drift from each other
 * or from `isTokenShape` itself if the charset or length bound ever changes.
 */
export const TOKEN_SHAPE_DETAIL =
  "telegram.token may contain only letters, digits, ':', '_' and '-', max 200 characters";

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * A stored number brought back inside its legal range, with the correction
 * NAMED rather than applied silently — the same rule this file already follows
 * for a discarded quiet-hours window and an unrecognised trigger.
 *
 * Presence is not enough for these fields. `settleMs.blocked: -5` restores the
 * edge-firing the settle window exists to remove (`setTimeout` treats a
 * negative delay as 0), and `cooldownMs: 0` disarms the per-agent rate limit
 * that bounds a failing send. The PUT route refuses both, but the file is also
 * reachable by a text editor, and a silently degraded notifier is precisely
 * what `migrate()` exists to prevent.
 */
const clamped = (
  v: number, lo: number, hi: number, field: string, log: (m: string) => void,
): number => {
  const c = Math.min(Math.max(v, lo), hi);
  // The corrected value names the bound that was hit, so the message does not
  // have to print a range whose upper end is `MAX_SAFE_INTEGER`.
  if (c !== v) {
    log(`[settings] notify.${field} was ${v}, outside its allowed range, and has been corrected to ${c}.`);
  }
  return c;
};

/**
 * Every stored shape, past or present, normalised to a complete v2 `Settings`.
 *
 * This replaces `{ ...defaults(), ...parsed }`, which was a SHALLOW merge: a
 * stored `notify` object replaced `defaults().notify` wholesale, so a v1 file
 * would load with no `settleMs` — and `setTimeout(fn, undefined)` fires
 * immediately, silently restoring the edge-firing bug. A shape whose absence
 * degrades to the old behaviour without erroring is worse than one that
 * throws, so every field is filled explicitly here.
 */
export function migrate(parsed: unknown, log: (m: string) => void = console.info): Settings {
  const d = defaults();
  const p = obj(parsed);
  const t = obj(p.telegram);
  const n = obj(p.notify);
  const s = obj(n.settleMs);

  // Named, not dropped silently: the operator configured a window and it is
  // being taken away, so say so and say what replaced it.
  if ("quietHours" in n && n.quietHours !== null) {
    const q = obj(n.quietHours);
    log(
      `[settings] quiet hours (${String(q.start)}-${String(q.end)}) is no longer supported ` +
        `and has been removed. Use "Mute for" in Settings instead.`,
    );
  }

  const isNotifyTrigger = (x: unknown): x is NotifyTrigger => x === "blocked" || x === "done";
  const triggers = Array.isArray(n.triggers) ? n.triggers.filter(isNotifyTrigger) : d.notify.triggers;
  // Named, not dropped silently, same as the quiet-hours discard above: a
  // corrupted or stale trigger name (a typo, or a value from a future
  // version) must not vanish with no trace — "never swallow an error" holds
  // here even though the safe recovery (drop the bad entry) is correct.
  if (Array.isArray(n.triggers)) {
    const dropped = n.triggers.filter((x) => !isNotifyTrigger(x));
    if (dropped.length > 0) {
      log(
        `[settings] notify.triggers entries ${dropped.map((x) => JSON.stringify(x)).join(", ")} ` +
          `are not valid triggers and have been dropped.`,
      );
    }
  }

  return {
    version: 2,
    telegram: {
      token: typeof t.token === "string" ? t.token : null,
      chatId: typeof t.chatId === "string" ? t.chatId : null,
    },
    notify: {
      enabled: typeof n.enabled === "boolean" ? n.enabled : d.notify.enabled,
      triggers,
      settleMs: {
        blocked: clamped(num(s.blocked, DEFAULT_SETTLE_MS.blocked), 0, MAX_SETTLE_MS, "settleMs.blocked", log),
        done: clamped(num(s.done, DEFAULT_SETTLE_MS.done), 0, MAX_SETTLE_MS, "settleMs.done", log),
      },
      mutedUntil: typeof n.mutedUntil === "number" && Number.isFinite(n.mutedUntil) ? n.mutedUntil : null,
      cooldownMs: clamped(
        num(n.cooldownMs, d.notify.cooldownMs),
        MIN_COOLDOWN_MS, Number.MAX_SAFE_INTEGER, "cooldownMs", log,
      ),
    },
    publicUrl: typeof p.publicUrl === "string" ? p.publicUrl : null,
  };
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
      const parsed = JSON.parse(raw) as unknown;
      this.#s = migrate(parsed);
      // Rewritten only when the stored shape was not already v2, so a normal
      // boot does not rewrite the file (and the token in it) for nothing.
      if (obj(parsed).version !== 2) await this.persist();
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
   * `telegram`, `notify` and `notify.settleMs` are all nested — a shallow
   * copy would alias exactly the fields a patch writes.
   */
  current(): Settings { return structuredClone(this.#s); }

  view(now: number = Date.now()): SettingsView {
    const t = this.#s.telegram.token;
    return {
      telegram: {
        configured: isConfigured(t),
        hint: isConfigured(t) ? t.slice(-4) : null,
        chatId: this.#s.telegram.chatId,
      },
      notify: {
        ...this.#s.notify,
        triggers: [...this.#s.notify.triggers],
        settleMs: { ...this.#s.notify.settleMs },
      },
      publicUrl: this.#s.publicUrl,
      serverNow: now,
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

  /** The only writer of `mutedUntil`. Narrow on purpose: it is the one
   *  notify field that is not part of the Save-button form, and routing it
   *  through `patch()` would put it back in the patch contract. */
  async patchMute(mutedUntil: number | null): Promise<void> {
    this.#s.notify = { ...this.#s.notify, mutedUntil };
    // Same rule as `patch()`: an explicit write clears a load fault, on the
    // theory that the operator has chosen to replace whatever was
    // unparseable. Tapping "Mute" is a narrower gesture than opening the
    // settings form and pressing Save, so this is a deliberate ruling, not a
    // copy-paste — the settings screen renders `error` as a banner above
    // every section, including wherever the mute control sits, so the
    // operator has already seen the fault before this fires. Two writers of
    // the same file disagreeing about `error` semantics (one clears it, one
    // leaves a stale fault behind a now-valid write) is a worse hazard than
    // the rare case this discards: a broken settings.json that may still
    // contain a token.
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
