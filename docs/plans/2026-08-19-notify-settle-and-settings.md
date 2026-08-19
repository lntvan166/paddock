# Notification settling and settings rework — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop paddock sending false "done" notifications, and make the settings screen usable from a phone.

**Architecture:** The notifier stops firing on the *edge* of a state transition and instead arms a timer per agent, sending only once the state has held for a per-trigger settle window. Quiet hours is deleted and replaced by an absolute "muted until" instant set through its own route so the server stamps the time. The settings form gains a sticky dirty-bar and a toast, and is split into section components.

**Tech Stack:** Bun, TypeScript (strict, `make check` = `bunx tsc --noEmit`), Hono routes, React 19 with no state library, `bun:test` + happy-dom for component tests, plain CSS with custom-property tokens.

**Spec:** `docs/design/2026-08-19-notifications-and-settings-design.md` — read it before starting. This plan implements it and does not repeat its reasoning.

## Global Constraints

- **This repository is public.** No hostnames, home paths, usernames, employer terms. Use `paddock.example.com`, `dev-box`, `operator`. Fixtures use invented agent names: `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`.
- **`make check-clean` before EVERY commit.** If it fails, fix the content — never add the string to an ignore list.
- **`make test` builds the UI first.** Never run bare `bun test` as the gate. `make check` must also pass (there is no linter).
- **Never swallow an error.** No `2>/dev/null`, no empty catch, no unconditional `exit 0`. A caught error is recorded and surfaced.
- **Dependency direction:** `herdr/socket → herdr/adapter → state/store → ws/hub → web/`. `notify/notifier.ts` is a leaf off the composition root; it may import `@shared/*` and `@server/settings/store`, never `@web/*`.
- **`src/shared/types.ts` is the one payload contract.** Never redeclare a payload shape on one side.
- **The Telegram token is never logged, echoed, or serialised** at any level. `sendTelegram`'s `(e as Error).message`-only catch exists because Bun attaches the token-bearing request URL to a fetch error — do not touch it.
- **A notification body carries name, state and link only.** Never `a.task`, never terminal output, never `cwd`.
- **UI:** no device detection, no `isMobile`, no user-agent parsing. Width media queries for layout, `(pointer: coarse)` for touch. Never define a colour only inside a media query — tokens on bare `:root`, then redefined under `prefers-color-scheme` and `[data-theme]`. Respect `prefers-reduced-motion` and `env(safe-area-inset-bottom)`. Touch targets are `2.75rem`.
- **Settle default values:** `{ blocked: 5_000, done: 10_000 }`. Validation bound `0 <= settleMs <= 600_000`. `MIN_COOLDOWN_MS` stays `1000`. Mute bound `0 <= forMs <= 7 days`. Retry cap 3 attempts.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/web/components/settings/DeviceSection.tsx` | The "This device" localStorage prefs. Behaviour unchanged, moved verbatim. |
| `src/web/components/settings/TelegramSection.tsx` | Token, chat id, and the relocated test button plus its result line. |
| `src/web/components/settings/NotifySection.tsx` | Mute, enabled, triggers + settle inputs, cooldown, public URL. |
| `src/web/components/settings/SaveBar.tsx` | Sticky "Unsaved changes" bar. Renders nothing when clean. |
| `src/web/components/settings/Toast.tsx` | `role="status"` live region for save success. |
| `tests/notifier-settle.test.ts` | Settle, cancel-on-reversal, per-trigger windows, dispose, forget. |
| `tests/notifier-timing.test.ts` | Mute suppression, cooldown deferral, bounded retry. |
| `tests/settings-save-bar.test.tsx` | Dirty tracking, bar visibility, toast, test-button payload. |

**Modified**

| File | Change |
|---|---|
| `src/shared/types.ts` | `SettingsView.notify`: drop `quietHours`, add `settleMs` + `mutedUntil`; add `SettingsView.serverNow`. Add `InlineKeyboard`. |
| `src/server/settings/store.ts` | `Settings.version: 2`, new `notify` fields, `migrate()`, `isTokenShape()`, `view(now)`. |
| `src/server/notify/notifier.ts` | Timers, four maps, `dispose()`, `composeMessage()`. Delete `inQuietHours`/`minutes`. |
| `src/server/notify/telegram.ts` | Optional `replyMarkup` on `SendOpts`, emitted as `reply_markup`. |
| `src/server/routes.ts` | Drop `quietHours` validation, add `settleMs` + token-shape validation, body creds on the test route, new mute route. |
| `src/server/index.ts` | `send` closure takes `replyMarkup`; call `notifier.dispose()` on shutdown. |
| `src/web/components/Settings.tsx` | Shrinks to shell: load, dirty tracking, save, sections. |
| `src/web/styles.css` | `.settings-save-bar`, `.settings-toast`, `.settings-mute`, `.settings-settle`. |
| `tests/notifier.test.ts` | Drop quiet-hours cases; harness gains `settleMs`/`mutedUntil` and injected timers. |
| `tests/settings-store.test.ts` | Migration cases. |
| `tests/settings-routes.test.ts` | Token shape, `settleMs`, test-route body creds, mute route. |
| `tests/settings-view.test.tsx`, `tests/prefs-applied.test.tsx`, `tests/notify-wiring.test.ts` | Fixture shape updates. |
| `tests/settings-styles.test.ts` | Guards for the new classes. |
| `docs/settings.md`, `docs/decisions.md`, `docs/architecture.md`, `docs/roadmap.md`, `README.md` | Per spec §11. |

**Note on Task 1:** it removes quiet hours before mute exists, so between Task 1 and Task 5 the branch has no time-based suppression at all. That is intentional — the alternative is maintaining two suppression mechanisms through the middle of the plan. Do not ship a build from the middle of this branch.

---

### Task 1: v2 settings schema, and quiet hours removed end-to-end

**Files:**
- Modify: `src/shared/types.ts` (`SettingsView`, `SettingsPatch`)
- Modify: `src/server/settings/store.ts:5-30` (`Settings`, `defaults`), `:66-95` (`load`), `:110-125` (`view`)
- Modify: `src/server/routes.ts:176-179` (delete `isHHMM`), `:247-259` (replace `quietHours` block)
- Modify: `src/server/notify/notifier.ts:1-22` (delete `minutes`, `inQuietHours`), `:80-86` (delete the call)
- Modify: `src/web/components/Settings.tsx` (delete `quietStart`/`quietEnd` state, the validation in `save()`, the two `<input type="time">` fields)
- Test: `tests/settings-store.test.ts`
- Modify: `tests/notifier.test.ts`, `tests/settings-view.test.tsx`, `tests/prefs-applied.test.tsx`, `tests/notify-wiring.test.ts`

**Interfaces:**
- Produces: `Settings` with `version: 2` and `notify.settleMs: Record<NotifyTrigger, number>`, `notify.mutedUntil: number | null`; `migrate(parsed: unknown, log?: (m: string) => void): Settings`; `SettingsStore.view(now?: number): SettingsView` including `serverNow: number`.

- [ ] **Step 1: Write the failing migration tests**

Append to `tests/settings-store.test.ts`:

```ts
import { migrate } from "@server/settings/store";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx bun test tests/settings-store.test.ts 2>&1 | tail -20`
Expected: FAIL — `export named 'migrate' not found` (and once that is fixed, `settleMs` undefined).

- [ ] **Step 3: Update the shared contract**

In `src/shared/types.ts`, replace the `SettingsView.notify` member and add `serverNow`:

```ts
export interface SettingsView {
  telegram: { configured: boolean; hint: string | null; chatId: string | null };
  notify: {
    enabled: boolean;
    triggers: NotifyTrigger[];
    /** Per trigger, how long the state must hold before a message is sent.
     *  0 fires on the edge, which is what v2 did unconditionally. */
    settleMs: Record<NotifyTrigger, number>;
    /** Epoch ms. Notifications are suppressed while `serverNow < mutedUntil`.
     *  An absolute instant rather than a schedule: it has no timezone to be
     *  misread by a phone in one zone and a server in another. */
    mutedUntil: number | null;
    cooldownMs: number;
  };
  publicUrl: string | null;
  /** The server's clock at the moment this view was built. The UI renders
   *  "muted until 07:14 (in 6h 22m)" from `mutedUntil`, and the phone's clock
   *  is not the server's — so the offset is computed from this, not Date.now(). */
  serverNow: number;
  error: string | null;
}

export interface SettingsPatch {
  telegram?: { token?: string | null; chatId?: string | null };
  /** `mutedUntil` is deliberately absent: mute is POST /api/settings/mute, so
   *  the server stamps the instant from a client-supplied duration, and so
   *  that "applies immediately" is structural rather than a convention. */
  notify?: Partial<Omit<SettingsView["notify"], "mutedUntil">>;
  publicUrl?: string | null;
}
```

- [ ] **Step 4: Rewrite the store's schema, `migrate`, and `view`**

In `src/server/settings/store.ts`, replace the `Settings` interface and `defaults`:

```ts
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

const defaults = (): Settings => ({
  version: 2,
  telegram: { token: null, chatId: null },
  notify: {
    enabled: false, triggers: ["blocked"], settleMs: { ...DEFAULT_SETTLE_MS },
    mutedUntil: null, cooldownMs: DEFAULT_COOLDOWN_MS,
  },
  publicUrl: null,
});
```

Add `migrate` above the class:

```ts
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

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

  return {
    version: 2,
    telegram: {
      token: typeof t.token === "string" ? t.token : null,
      chatId: typeof t.chatId === "string" ? t.chatId : null,
    },
    notify: {
      enabled: typeof n.enabled === "boolean" ? n.enabled : d.notify.enabled,
      triggers: Array.isArray(n.triggers)
        ? n.triggers.filter((x): x is NotifyTrigger => x === "blocked" || x === "done")
        : d.notify.triggers,
      settleMs: {
        blocked: num(s.blocked, DEFAULT_SETTLE_MS.blocked),
        done: num(s.done, DEFAULT_SETTLE_MS.done),
      },
      mutedUntil: typeof n.mutedUntil === "number" && Number.isFinite(n.mutedUntil) ? n.mutedUntil : null,
      cooldownMs: num(n.cooldownMs, d.notify.cooldownMs),
    },
    publicUrl: typeof p.publicUrl === "string" ? p.publicUrl : null,
  };
}
```

Replace the JSON-parse branch of `load()`:

```ts
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
```

Give `view` the clock:

```ts
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
```

- [ ] **Step 5: Run the store tests to verify they pass**

Run: `bunx bun test tests/settings-store.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Strip quiet hours from the validator**

In `src/server/routes.ts`: delete `isHHMM` (lines 176-179) and replace the whole `if ("quietHours" in nn) { … }` block with `settleMs` validation:

```ts
    if ("settleMs" in nn) {
      const raw = nn.settleMs;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { ok: false, detail: "notify.settleMs must be an object of {blocked, done}" };
      }
      const sm = raw as Record<string, unknown>;
      const out2: Record<string, number> = {};
      for (const k of ["blocked", "done"] as const) {
        const v = sm[k];
        // Both keys required: a partial object would leave the other trigger's
        // window undefined once merged, and undefined fires immediately.
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_SETTLE_MS) {
          return { ok: false, detail: `notify.settleMs.${k} must be a number between 0 and ${MAX_SETTLE_MS}` };
        }
        out2[k] = v;
      }
      out.settleMs = out2 as Record<NotifyTrigger, number>;
    }
```

Import `MAX_SETTLE_MS` from `@server/settings/store` alongside the existing `isConfigured`.

- [ ] **Step 7: Delete `inQuietHours` from the notifier**

In `src/server/notify/notifier.ts` delete the `minutes` helper, the `inQuietHours` export and its doc comment (lines 5-22), and the `if (inQuietHours(...)) return;` block in `#one` with its comment. Nothing replaces it in this task — mute arrives in Task 5.

- [ ] **Step 8: Strip quiet hours from the UI**

In `src/web/components/Settings.tsx`: delete the `quietStart` / `quietEnd` `useState` pair, the two lines that seed them in the GET effect, the whole `if ((quietStart === "") !== (quietEnd === ""))` guard at the top of `save()` and its comment, the `quietHours:` member of the patch, and the `<div className="settings-field-row">` containing both `<input type="time">` fields.

- [ ] **Step 9: Update every fixture that names quietHours**

Four files. In `tests/notifier.test.ts` change the `HarnessOpts.notify` type and the harness's `notify` literal; in the others change the view fixture:

```ts
// tests/notifier.test.ts — HarnessOpts.notify
  notify?: Partial<{
    enabled: boolean; triggers: string[];
    settleMs: { blocked: number; done: number };
    mutedUntil: number | null; cooldownMs: number;
  }>;

// tests/notifier.test.ts — harness store.current()
      notify: {
        enabled: true, triggers: ["blocked"],
        settleMs: { blocked: 0, done: 0 }, mutedUntil: null, cooldownMs: 60_000,
        ...o.notify,
      },
```

`settleMs: 0` in the default harness keeps every existing test asserting on edge behaviour valid while Task 2 lands; the settle-specific tests set their own windows.

```ts
// tests/settings-view.test.tsx and tests/prefs-applied.test.tsx — view fixture
  notify: { enabled: true, triggers: ["blocked"], settleMs: { blocked: 5_000, done: 10_000 },
            mutedUntil: null, cooldownMs: 60_000 },
  publicUrl: null, serverNow: 1_700_000_000_000, error: null,

// tests/notify-wiring.test.ts
        notify: { enabled: true, triggers: ["blocked"], settleMs: { blocked: 0, done: 0 },
                  mutedUntil: null, cooldownMs: 0 },
```

Delete the two quiet-hours tests in `tests/notifier.test.ts` (the pure `inQuietHours` case around line 154 and the notifier-level drop case around line 209). Their replacements are Task 5's mute tests.

Also delete `tests/settings-view.test.tsx:150` — "clearing one half of quiet hours is refused, not silently applied as 'no quiet hours'". It drives `input[name="quietStart"]` / `quietEnd`, which no longer exist, so it cannot be repaired, only removed. Nothing replaces it: the half-window class of bug goes away with the field.

`tests/settings-view.test.tsx:123` — "Save is disabled until the settings have loaded" — keeps passing in this task and is re-expressed in Task 8, where `dirty` is false while `baseline === null` and the bar therefore never renders. Do not delete it here.

- [ ] **Step 10: Run the full gate**

Run: `make check && make test 2>&1 | tail -25`
Expected: zero TypeScript errors, all tests pass.

- [ ] **Step 11: Commit**

```bash
make check-clean
git add -A
git commit -m "feat: settings schema v2, and quiet hours removed

A shallow spread meant a v1 file would load with no settleMs, and an
undefined window fires immediately — so migrate() fills every field
explicitly and names the quiet-hours window it discards.

Nothing suppresses by time until mute lands."
```

---

### Task 2: The notifier settles instead of firing on the edge

**Files:**
- Modify: `src/server/notify/notifier.ts` (`NotifierOpts`, the class body)
- Modify: `src/server/index.ts:189` (the `send` closure signature is unchanged here; `dispose()` wiring lands in Task 3)
- Test: `tests/notifier-settle.test.ts` (create)

**Interfaces:**
- Consumes: `Settings.notify.settleMs` from Task 1.
- Produces: `NotifierOpts.setTimer?: (fn: () => void, ms: number) => TimerHandle`, `NotifierOpts.clearTimer?: (h: TimerHandle) => void`, `type TimerHandle = ReturnType<typeof setTimeout>`, `Notifier.dispose(): void`. `Notifier.observe` becomes fully synchronous.

- [ ] **Step 1: Write the failing settle tests**

Create `tests/notifier-settle.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Notifier, type TimerHandle } from "@server/notify/notifier";
import type { Agent, NotifyTrigger } from "@shared/types";

const NOW = 1_700_000_000_000;

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
  task: "Extract auth middleware", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", stateSince: NOW,
  updatedAt: NOW, acknowledgedAt: null, ...over,
});

/**
 * A controllable clock and timer queue. Timers are injected rather than real
 * because a settle window is 5-10 SECONDS: a test that waited would add ten
 * seconds to `make test` for every case, and one that lowered the window to
 * 1ms would stop testing the thing that matters (that the window is read from
 * settings at all).
 */
function harness(o: {
  settleMs?: Partial<Record<NotifyTrigger, number>>;
  triggers?: NotifyTrigger[];
  cooldownMs?: number;
} = {}) {
  const sent: string[] = [];
  let now = NOW;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: {
        enabled: true,
        triggers: o.triggers ?? (["blocked", "done"] as NotifyTrigger[]),
        settleMs: { blocked: 5_000, done: 10_000, ...o.settleMs },
        mutedUntil: null,
        cooldownMs: o.cooldownMs ?? 0,
      },
      publicUrl: null,
    }),
  };

  const n = new Notifier({
    settings: store as never,
    send: async (text: string) => { sent.push(text); return { ok: true, detail: null }; },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id as unknown as TimerHandle;
    },
    clearTimer: (h) => { timers.delete(h as unknown as number); },
  });

  /** Advance the clock and run every timer that has come due. */
  async function advance(ms: number): Promise<void> {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) { timers.delete(id); t.fn(); }
    }
    await Bun.sleep(1); // let the fire path's await settle
  }

  return { n, sent, advance, pending: () => timers.size };
}

test("a subagent handoff sends nothing at all", async () => {
  // THE reported bug. A main agent that delegates goes working -> done the
  // instant the subagent returns, then back to working when it reviews the
  // result. Firing on the edge makes that message true when sent and stale
  // when read, which is worse than silence: it teaches the operator to
  // ignore the channel.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(3_000);
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  await h.advance(60_000);
  expect(h.sent).toEqual([]);
});

test("a state held for the whole window fires exactly once", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(9_999);
  expect(h.sent).toEqual([]);
  await h.advance(2);
  expect(h.sent).toEqual(["api-refactor is done"]);
  // A later task-line-only delta must not re-announce the same state.
  h.n.observe({ upserted: [agent({ state: "done", task: "wrote the report" })], removedIds: [] });
  await h.advance(60_000);
  expect(h.sent).toEqual(["api-refactor is done"]);
});

test("blocked uses its own shorter window, not done's", async () => {
  // If both shared one window, the alert the operator most wants fast would
  // wait as long as the one that lies.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await h.advance(5_000);
  expect(h.sent).toEqual(["api-refactor is blocked"]);
});

test("a settleMs of 0 fires on the edge, so the feature can be turned off", async () => {
  const h = harness({ settleMs: { done: 0 } });
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(0);
  expect(h.sent).toEqual(["api-refactor is done"]);
});

test("a non-trigger state arms no timer", async () => {
  const h = harness({ triggers: ["blocked"] });
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  expect(h.pending()).toBe(0);
});

test("first sight after boot arms nothing", async () => {
  // Preserved from v2 deliberately: paddock cannot tell "just blocked" from
  // "blocked for an hour", and announcing every agent on every restart is
  // its own noise problem.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await h.advance(60_000);
  expect(h.sent).toEqual([]);
});

test("dispose clears pending timers", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  expect(h.pending()).toBe(1);
  h.n.dispose();
  expect(h.pending()).toBe(0);
  await h.advance(60_000);
  expect(h.sent).toEqual([]);
});

test("a removed agent forgets that it was notified, so a returning id can notify again", async () => {
  // #lastNotified surviving a removal would silently suppress the first real
  // notification for whatever agent next holds that pane id.
  const h = harness({ settleMs: { done: 0 } });
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(0);
  h.n.observe({ upserted: [], removedIds: ["w1:p1"] });
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(0);
  expect(h.sent).toEqual(["api-refactor is done", "api-refactor is done"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx bun test tests/notifier-settle.test.ts 2>&1 | tail -20`
Expected: FAIL — `export named 'TimerHandle' not found`, and `dispose` is not a function.

- [ ] **Step 3: Rewrite the notifier body**

Replace everything in `src/server/notify/notifier.ts` from `export interface NotifierOpts` down to the end of the class with:

```ts
export type TimerHandle = ReturnType<typeof setTimeout>;

const isTrigger = (s: AgentState): s is NotifyTrigger => s === "blocked" || s === "done";

export interface NotifierOpts {
  settings: SettingsStore;
  send: (text: string) => Promise<{ ok: boolean; detail: string | null }>;
  now?: () => number;
  /** Injected so tests drive 5-10 SECOND windows without waiting them out.
   *  The default unrefs, so a pending settle cannot hold the process open. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
}

export class Notifier {
  /** What we last SAW. Always the truth, never reverted. */
  #lastSeen = new Map<string, AgentState>();
  /** What we last SENT A MESSAGE ABOUT. Splitting this from `#lastSeen` is
   *  what removes v2's optimistic-write-and-revert dance: one map was doing
   *  both jobs, and every subtlety in the old comments came from that. */
  #lastNotified = new Map<string, AgentState>();
  /** Last send ATTEMPT (not success) per agent, for the cooldown. */
  #lastSentAt = new Map<string, number>();
  /** In-flight settle windows. At most one per agent. */
  #pending = new Map<string, { state: NotifyTrigger; timer: TimerHandle; attempts: number }>();
  lastError: string | null = null;

  constructor(private o: NotifierOpts) {}

  #now(): number { return (this.o.now ?? Date.now)(); }

  #setTimer(fn: () => void, ms: number): TimerHandle {
    if (this.o.setTimer) return this.o.setTimer(fn, ms);
    const t = setTimeout(fn, ms);
    // A settle window must never be the reason the process stays alive.
    t.unref?.();
    return t;
  }

  #clearTimer(h: TimerHandle): void {
    if (this.o.clearTimer) this.o.clearTimer(h);
    else clearTimeout(h);
  }

  /**
   * Synchronous, and now genuinely so: the send happens later, on a timer, so
   * nothing here awaits a third party's latency in front of the WebSocket
   * broadcast this fans out alongside.
   */
  observe(d: Delta): void {
    for (const a of d.upserted) this.#see(a);
    for (const id of d.removedIds) this.#forget(id);
  }

  /** Clears every pending timer. Called from the server's shutdown path. */
  dispose(): void {
    for (const p of this.#pending.values()) this.#clearTimer(p.timer);
    this.#pending.clear();
  }

  #cancel(agentId: string): void {
    const p = this.#pending.get(agentId);
    if (p === undefined) return;
    this.#clearTimer(p.timer);
    this.#pending.delete(agentId);
  }

  #forget(agentId: string): void {
    this.#cancel(agentId);
    this.#lastSeen.delete(agentId);
    // Deleted too, or a returning pane id inherits a suppression it never
    // earned and its first real notification is silently dropped.
    this.#lastNotified.delete(agentId);
    this.#lastSentAt.delete(agentId);
  }

  #see(a: Agent): void {
    const prev = this.#lastSeen.get(a.agentId);
    this.#lastSeen.set(a.agentId, a.state);
    // First sight: paddock cannot tell "just blocked" from "blocked an hour
    // ago", so a restart announces nothing.
    if (prev === undefined || prev === a.state) return;

    // The state moved, so whatever the pending timer was going to claim is
    // void. THIS is the cancel that fixes the subagent handoff; the check at
    // fire time is a guard against a race, not the mechanism.
    this.#cancel(a.agentId);
    if (!isTrigger(a.state)) return;

    const s = this.o.settings.current();
    if (!s.notify.triggers.includes(a.state)) return;
    this.#arm(a, a.state, s.notify.settleMs[a.state], 0);
  }

  #arm(a: Agent, state: NotifyTrigger, ms: number, attempts: number): void {
    const timer = this.#setTimer(() => {
      this.#pending.delete(a.agentId);
      // Nothing else is left to observe a rejection here, and Bun TERMINATES
      // the process on an unhandled one — a `fetch` that throws rather than
      // resolving would take the whole dashboard down over a notification.
      // Recorded on `lastError`, which /api/health exposes, never swallowed.
      void this.#fire(a, state, attempts).catch((e: unknown) => {
        this.lastError = e instanceof Error ? e.message : String(e);
      });
    }, ms);
    this.#pending.set(a.agentId, { state, timer, attempts });
  }

  async #fire(a: Agent, state: NotifyTrigger, attempts: number): Promise<void> {
    if (this.#lastSeen.get(a.agentId) !== state) return;
    if (this.#lastNotified.get(a.agentId) === state) return;

    const s = this.o.settings.current();
    if (!s.notify.enabled) return;
    if (!s.notify.triggers.includes(state)) return;
    // `isConfigured`, not `!== null`: the two differ for an empty string, and
    // an unset environment variable IS an empty string.
    if (!isConfigured(s.telegram.token) || !isConfigured(s.telegram.chatId)) return;

    this.#lastSentAt.set(a.agentId, this.#now());

    // Name, state, link. NOTHING ELSE — and specifically NOT `a.task`, which
    // is live agent-authored text that may carry a pasted credential.
    // Telegram bot messages are not end-to-end encrypted; content minimalism
    // is the ONLY mitigation the design claims for choosing Telegram over Web
    // Push, and adding a field here spends it.
    const link = s.publicUrl ? `\n${s.publicUrl.replace(/\/+$/, "")}/${agentHash(a.agentId)}` : "";
    const r = await this.o.send(`${a.name} is ${state}${link}`);
    if (r.ok) {
      this.#lastNotified.set(a.agentId, state);
      this.lastError = null;
      return;
    }
    this.lastError = r.detail ?? "send failed";
    // The retry lands in Task 3. `attempts` is unused until then, which is
    // fine — tsconfig sets `noUnusedLocals` but not `noUnusedParameters`. Do
    // NOT add a `MAX_ATTEMPTS` const here for the same reason: an unexported
    // unused const IS flagged, so Task 3 declares it where it is first read.
  }
}
```

Keep the existing imports and add `NotifyTrigger` to the `@shared/types` import. Leave `fanOut` at the bottom of the file untouched.

- [ ] **Step 4: Run both notifier suites to verify they pass**

Run: `bunx bun test tests/notifier-settle.test.ts tests/notifier.test.ts 2>&1 | tail -25`
Expected: PASS. `tests/notifier.test.ts` passes because Task 1 set its harness windows to 0; if a case there asserted on the revert behaviour that no longer exists, delete it and note which in the commit body.

- [ ] **Step 5: Prove the cancel is load-bearing**

Comment out the `this.#cancel(a.agentId);` line in `#see` and run:

Run: `bunx bun test tests/notifier-settle.test.ts 2>&1 | tail -10`
Expected: FAIL on "a subagent handoff sends nothing at all". If it still passes, the test is decorative — fix the test before restoring the line. Restore the line and re-run to green.

- [ ] **Step 6: Run the full gate and commit**

```bash
make check && make test 2>&1 | tail -25
make check-clean
git add -A
git commit -m "feat: notify only once a state has settled

A main agent that delegates goes working -> done the instant a subagent
returns. Firing on that edge makes a message that is true when sent and
stale when read. The transition now arms a per-trigger timer, and the
next transition cancels it.

Splitting lastSeen from lastNotified removes the optimistic-write-and-
revert dance: lastSeen only ever holds the truth."
```

---

### Task 3: Mute, cooldown deferral, and a bounded retry

**Files:**
- Modify: `src/server/notify/notifier.ts` (`#fire`)
- Modify: `src/server/index.ts` (call `notifier.dispose()` from the signal handler)
- Test: `tests/notifier-timing.test.ts` (create)

**Interfaces:**
- Consumes: `#arm`, `#fire`, `MAX_ATTEMPTS`, `Settings.notify.mutedUntil` from Tasks 1-2.
- Produces: no new exports. `#fire` gains the mute gate, the deferring cooldown, and the retry.

- [ ] **Step 1: Write the failing timing tests**

Create `tests/notifier-timing.test.ts`. Reuse the Task 2 harness shape, extended for mute and send failure:

```ts
import { expect, test } from "bun:test";
import { Notifier, type TimerHandle } from "@server/notify/notifier";
import type { Agent, NotifyTrigger } from "@shared/types";

const NOW = 1_700_000_000_000;

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "flaky-test-fix",
  task: "Re-running the suite", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", stateSince: NOW,
  updatedAt: NOW, acknowledgedAt: null, ...over,
});

function harness(o: { mutedUntil?: number | null; cooldownMs?: number; failWith?: string } = {}) {
  const sent: string[] = [];
  let now = NOW;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let muted = o.mutedUntil ?? null;

  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: {
        enabled: true, triggers: ["blocked", "done"] as NotifyTrigger[],
        settleMs: { blocked: 0, done: 0 }, mutedUntil: muted,
        cooldownMs: o.cooldownMs ?? 0,
      },
      publicUrl: null,
    }),
  };

  const n = new Notifier({
    settings: store as never,
    send: async (text: string) => {
      if (o.failWith !== undefined) return { ok: false, detail: o.failWith };
      sent.push(text);
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

  async function advance(ms: number): Promise<void> {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) { timers.delete(id); t.fn(); }
    }
    await Bun.sleep(1);
  }

  return { n, sent, advance, notifier: n, setMuted: (v: number | null) => { muted = v; },
           pending: () => timers.size };
}

/** Drive one agent from working into a trigger state. */
function transition(n: Notifier, state: Agent["state"]): void {
  n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  n.observe({ upserted: [agent({ state })], removedIds: [] });
}

test("mute suppresses the message", async () => {
  const h = harness({ mutedUntil: NOW + 60_000 });
  transition(h.n, "blocked");
  await h.advance(0);
  expect(h.sent).toEqual([]);
});

test("a message suppressed by mute is dropped, not delivered when mute expires", async () => {
  // A pile delivered at 08:00 describes agents unblocked five hours earlier —
  // noise wearing the costume of signal. Carried over verbatim from the quiet
  // hours reasoning it replaces.
  const h = harness({ mutedUntil: NOW + 60_000 });
  transition(h.n, "blocked");
  await h.advance(0);
  h.setMuted(null);
  await h.advance(120_000);
  expect(h.sent).toEqual([]);
});

test("mute is read at fire time, so muting during a settle window still silences", async () => {
  const h = harness();
  transition(h.n, "blocked");
  h.setMuted(NOW + 60_000);
  await h.advance(0);
  expect(h.sent).toEqual([]);
});

test("a cooldown miss defers the message rather than losing it", async () => {
  // The cooldown bounds how OFTEN paddock may speak about one agent. Treating
  // it as a drop would lose a real finish because a blocked message went out
  // 20s earlier — which is exactly the notification the operator wanted.
  const h = harness({ cooldownMs: 60_000 });
  transition(h.n, "blocked");
  await h.advance(0);
  expect(h.sent).toEqual(["flaky-test-fix is blocked"]);

  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(20_000);
  expect(h.sent).toEqual(["flaky-test-fix is blocked"]);   // still inside the window
  await h.advance(41_000);
  expect(h.sent).toEqual(["flaky-test-fix is blocked", "flaky-test-fix is done"]);
});

test("a failed send retries at the cooldown, three attempts, then stops", async () => {
  const h = harness({ cooldownMs: 60_000, failWith: "chat not found" });
  transition(h.n, "blocked");
  await h.advance(0);
  expect(h.notifier.lastError).toBe("chat not found");
  await h.advance(60_001);
  await h.advance(60_001);
  // Third attempt has now run; nothing further may be armed.
  expect(h.pending()).toBe(0);
  await h.advance(600_000);
  expect(h.pending()).toBe(0);
  expect(h.notifier.lastError).toBe("chat not found");
});

test("a cooldown deferral does not consume a retry attempt", async () => {
  // Otherwise a busy agent burns its three attempts on deferrals and the
  // message is never sent at all.
  const h = harness({ cooldownMs: 30_000 });
  transition(h.n, "blocked");
  await h.advance(0);
  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(10_000);
  await h.advance(10_000);
  await h.advance(11_000);
  expect(h.sent).toEqual(["flaky-test-fix is blocked", "flaky-test-fix is done"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx bun test tests/notifier-timing.test.ts 2>&1 | tail -20`
Expected: FAIL — mute is not checked, so "mute suppresses the message" sends anyway.

- [ ] **Step 3: Add the three gates to `#fire`**

In `src/server/notify/notifier.ts`, replace the block from `if (!isConfigured(...)) return;` through the end of `#fire` with:

```ts
    if (!isConfigured(s.telegram.token) || !isConfigured(s.telegram.chatId)) return;

    const now = this.#now();
    // Dropped, never queued: a pile delivered when mute lifts describes
    // agents unblocked hours earlier. Read HERE rather than when the timer
    // was armed, so muting during a settle window still silences.
    if (s.notify.mutedUntil !== null && now < s.notify.mutedUntil) return;

    const since = now - (this.#lastSentAt.get(a.agentId) ?? Number.NEGATIVE_INFINITY);
    if (since < s.notify.cooldownMs) {
      // DEFER, not drop. The cooldown bounds how often paddock may speak
      // about one agent; dropping would lose a real finish because a blocked
      // message went out moments earlier. `attempts` is unchanged — a
      // deferral is not a failure, and counting it would let a busy agent
      // burn its retries on deferrals and never send at all.
      this.#arm(a, state, s.notify.cooldownMs - since, attempts);
      return;
    }

    // Stamped per ATTEMPT, not per success. A broken token fails every send,
    // and recording only successes leaves `since` permanently infinite —
    // which is how the retry path becomes one Telegram POST per delta.
    this.#lastSentAt.set(a.agentId, now);

    const link = s.publicUrl ? `\n${s.publicUrl.replace(/\/+$/, "")}/${agentHash(a.agentId)}` : "";
    const r = await this.o.send(`${a.name} is ${state}${link}`);
    if (r.ok) {
      this.#lastNotified.set(a.agentId, state);
      this.lastError = null;
      return;
    }
    this.lastError = r.detail ?? "send failed";
    // Bounded. v2 "retried on the next delta", which for a finished agent can
    // never happen — a quiet `done` agent produces no further deltas, so a
    // failed finish notification was lost outright.
    if (attempts + 1 < MAX_ATTEMPTS) this.#arm(a, state, s.notify.cooldownMs, attempts + 1);
```

Add the constant that Task 2 deliberately left out, above the class:

```ts
/** Attempts per settled transition, including the first. */
const MAX_ATTEMPTS = 3;
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx bun test tests/notifier-timing.test.ts tests/notifier-settle.test.ts tests/notifier.test.ts 2>&1 | tail -25`
Expected: PASS.

- [ ] **Step 5: Prove the deferral is load-bearing**

Change the cooldown branch to `return;` without arming, and run:

Run: `bunx bun test tests/notifier-timing.test.ts 2>&1 | tail -10`
Expected: FAIL on "a cooldown miss defers the message rather than losing it". Restore and re-run to green.

- [ ] **Step 6: Dispose on shutdown**

In `src/server/index.ts`, inside the `SIGINT`/`SIGTERM` handler (around line 400), call `dispose` before clearing state:

```ts
  process.on(signal, () => {
    if (clearing) return;
    clearing = true;
    // Pending settle timers are unref'd, so they cannot hold the process
    // open — but a timer that fires against a torn-down store would report
    // about an agent nobody is watching any more.
    notifier.dispose();
    void removeState(stateDir)
      .catch((e) => console.error(`paddock: could not clear state file (${String(e)})`))
      .finally(() => process.exit(0));
  });
```

- [ ] **Step 7: Run the full gate and commit**

```bash
make check && make test 2>&1 | tail -25
make check-clean
git add -A
git commit -m "feat: mute, a deferring cooldown, and a bounded retry

Mute is read at fire time and drops rather than queues. A cooldown miss
re-arms for the remainder instead of losing the message, and does not
consume a retry attempt. A failed send retries at the cooldown, three
attempts, then stops with lastError set — v2's retry-on-next-delta could
never fire for a done agent, which produces no further deltas."
```

---

### Task 4: A token's shape is validated

**Files:**
- Modify: `src/server/settings/store.ts` (add `isTokenShape` beside `isConfigured`)
- Modify: `src/server/routes.ts` (`validateSettingsPatch` telegram branch)
- Test: `tests/settings-routes.test.ts`

**Interfaces:**
- Produces: `isTokenShape(v: string): boolean` exported from `@server/settings/store`.

- [ ] **Step 1: Write the failing tests**

`tests/settings-routes.test.ts` already has the helper these use — `harness(sendTest?)`, which builds a `SettingsStore` over a fresh temp dir with `{}` for env (never `process.env`, or a machine that followed the README starts pre-configured and the unconfigured-default assertions fail) and returns `{ app, settings }`. Use it; do not add a second helper. Stored credentials are seeded with `await settings.patch({ telegram: { … } })`, exactly as the existing tests in that file do.

Append:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx bun test tests/settings-routes.test.ts 2>&1 | tail -20`
Expected: FAIL — the slash token returns 200.

- [ ] **Step 3: Add the predicate**

In `src/server/settings/store.ts`, below `isConfigured`:

```ts
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
```

- [ ] **Step 4: Use it in the validator**

In `src/server/routes.ts`, in `validateSettingsPatch`'s telegram branch, extend the token check:

```ts
    if ("token" in tt) {
      if (!isNullableString(tt.token)) return { ok: false, detail: "telegram.token must be a string or null" };
      // Empty string clears it, same as null (see isConfigured). Any other
      // value must be path-safe — the detail names the rule and NEVER echoes
      // the value, which is the credential.
      if (tt.token !== null && tt.token !== "" && !isTokenShape(tt.token)) {
        return {
          ok: false,
          detail: "telegram.token may contain only letters, digits, ':', '_' and '-', max 200 characters",
        };
      }
      out.token = tt.token;
    }
```

Add `isTokenShape` to the existing `@server/settings/store` import.

- [ ] **Step 5: Run to verify it passes**

Run: `bunx bun test tests/settings-routes.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
make check && make test 2>&1 | tail -25
make check-clean
git add -A
git commit -m "fix: refuse a token that would redirect the Telegram API path

The token is interpolated into api.telegram.org/bot\${token}/sendMessage,
so one containing a slash addresses a different method. Pre-existing on
the stored-token path; guarded now in one place."
```

---

### Task 5: The test route uses on-screen credentials

**Files:**
- Modify: `src/server/routes.ts:565-578`
- Test: `tests/settings-routes.test.ts`

**Interfaces:**
- Consumes: `isConfigured`, `isTokenShape`.
- Produces: `POST /api/settings/telegram/test` accepting `{ token?: string; chatId?: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx bun test tests/settings-routes.test.ts 2>&1 | tail -20`
Expected: FAIL — the body is ignored, so the first test's `calls` records the stored values (or 400).

- [ ] **Step 3: Rewrite the route**

Replace `src/server/routes.ts:565-578` with:

```ts
    app.post("/api/settings/telegram/test", async (c) => {
      const parsed = await strictJsonBody(c);
      if (!parsed.ok) return c.json({ ok: false, detail: parsed.detail }, 400);
      const body = parsed.body;

      // Resolved PER FIELD: an absent or blank value falls back to the stored
      // one via the same `isConfigured` predicate the view and the notifier
      // use. This is what lets an operator verify a pasted token before
      // committing it — the only order anyone actually tries.
      const s = settings.current();
      const pick = (typed: unknown, stored: string | null): string | null => {
        if (typeof typed === "string" && isConfigured(typed)) return typed;
        return isConfigured(stored) ? stored : null;
      };
      const token = pick(body.token, s.telegram.token);
      const chatId = pick(body.chatId, s.telegram.chatId);

      if (token === null || chatId === null) {
        return c.json({ ok: false, detail: "token and chat id must both be set" }, 400);
      }
      // Checked before the request, so a path-unsafe token never reaches a
      // URL. The detail names the rule and never echoes the value.
      if (!isTokenShape(token)) {
        return c.json({
          ok: false,
          detail: "telegram.token may contain only letters, digits, ':', '_' and '-', max 200 characters",
        }, 400);
      }

      // Deliberately does NOT save. A probe is not a commit.
      // `sendTest` is the local already resolved at routes.ts:526
      // (`deps.sendTest ?? sendTelegram`) — do not re-resolve it here.
      const r = await sendTest({
        token, chatId,
        text: "paddock test message — notifications are wired up.",
      });
      return c.json(r);
    });
```

`strictJsonBody` is the existing helper at `routes.ts:161`; reuse it rather than calling `c.req.json()` directly, so a malformed or non-object body is refused with the same message as every other route.

- [ ] **Step 4: Run to verify it passes**

Run: `bunx bun test tests/settings-routes.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
make check && make test 2>&1 | tail -25
make check-clean
git add -A
git commit -m "feat: test a typed token before committing it

The route read settings.current(), so pasting a token and pressing Send
test message answered 'token and chat id must both be set'. It now takes
credentials from the POST body, falling back per field to the stored
ones, and does not save on success."
```

---

### Task 6: The mute route

**Files:**
- Modify: `src/server/routes.ts` (new route beside the settings routes)
- Test: `tests/settings-routes.test.ts`

**Interfaces:**
- Produces: `POST /api/settings/mute` with body `{ forMs: number }`, returning `SettingsView`.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

These use a second parameter on the existing `harness` helper, which today takes only `sendTest`. Widen it in this step — `harness(sendTest?, now?: () => number)` — and pass `now` straight through to `createApp`. `AppDeps` has no clock at all yet; Step 3 adds one.

`Number.NaN` and `"4h"` survive `JSON.stringify` as `null` and `"4h"` respectively, and both must be refused by the `typeof forMs !== "number"` / `Number.isFinite` checks — that is the point of including them.

- [ ] **Step 2: Run to verify it fails**

Run: `bunx bun test tests/settings-routes.test.ts 2>&1 | tail -20`
Expected: FAIL — 404 on `/api/settings/mute`.

- [ ] **Step 3: Add the clock and the route**

In `AppDeps`:

```ts
  /** Injected so mute's stamped instant is assertable. Defaults to Date.now. */
  now?: () => number;
```

Beside the other settings routes:

```ts
    /**
     * Mute is its own route, not a `notify` patch field, for two reasons.
     * The server stamps the instant from a client-supplied DURATION, so a
     * phone with a skewed clock cannot set a wrong one. And mute must apply
     * immediately while every other field waits for Save — a separate
     * endpoint makes that structural instead of a rule to remember.
     */
    app.post("/api/settings/mute", async (c) => {
      const parsed = await strictJsonBody(c);
      if (!parsed.ok) return c.json({ ok: false, detail: parsed.detail }, 400);
      const forMs = parsed.body.forMs;
      if (typeof forMs !== "number" || !Number.isFinite(forMs) || forMs < 0 || forMs > MAX_MUTE_MS) {
        return c.json({ ok: false, detail: `forMs must be a number between 0 and ${MAX_MUTE_MS}` }, 400);
      }
      const now = (deps.now ?? Date.now)();
      // 0 means unmute. `notify.enabled` is the "off until further notice"
      // control, so there is deliberately no infinite mute here.
      await settings.patchMute(forMs === 0 ? null : now + forMs);
      return c.json(settings.view(now));
    });
```

Add above the route table:

```ts
/** A week. Long enough for a holiday, short enough that a fat-fingered mute
 *  cannot silence paddock for a year. */
const MAX_MUTE_MS = 7 * 24 * 60 * 60 * 1000;
```

- [ ] **Step 4: Add `patchMute` to the store**

`SettingsPatch.notify` deliberately omits `mutedUntil` (Task 1), so `patch()` cannot carry it. Add a narrow method to `SettingsStore`:

```ts
  /** The only writer of `mutedUntil`. Narrow on purpose: it is the one
   *  notify field that is not part of the Save-button form, and routing it
   *  through `patch()` would put it back in the patch contract. */
  async patchMute(mutedUntil: number | null): Promise<void> {
    this.#s.notify = { ...this.#s.notify, mutedUntil };
    this.error = null;
    await this.persist();
  }
```

- [ ] **Step 5: Serve `serverNow` consistently**

Every place `routes.ts` serialises the view must pass the same clock. Replace bare `settings.view()` calls with `settings.view((deps.now ?? Date.now)())` in the GET and PUT handlers.

- [ ] **Step 6: Run to verify it passes**

Run: `bunx bun test tests/settings-routes.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
make check && make test 2>&1 | tail -25
make check-clean
git add -A
git commit -m "feat: POST /api/settings/mute, stamped server-side

The client sends a duration and the server stamps the instant, so a
skewed phone clock cannot set a wrong one. Its own route rather than a
patch field, so 'applies immediately' is structural."
```

---

### Task 7: Split Settings.tsx, changing no behaviour

**Files:**
- Create: `src/web/components/settings/DeviceSection.tsx`, `TelegramSection.tsx`, `NotifySection.tsx`
- Modify: `src/web/components/Settings.tsx`
- Test: no new tests. `tests/settings-view.test.tsx` and `tests/prefs-applied.test.tsx` must pass **unchanged**.

**Interfaces:**
- Produces:

```ts
export function DeviceSection(p: {
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
}): JSX.Element;

export function TelegramSection(p: {
  token: string; setToken: (v: string) => void;
  chatId: string; setChatId: (v: string) => void;
  tokenPlaceholder: string;
  testing: boolean;
  testResult: { ok: boolean; detail: string | null } | null;
  onTest: () => void;
}): JSX.Element;

export function NotifySection(p: {
  notifyEnabled: boolean; setNotifyEnabled: (v: boolean) => void;
  triggers: NotifyTrigger[]; toggleTrigger: (t: NotifyTrigger) => void;
  cooldownMs: number; setCooldownMs: (v: number) => void;
  publicUrl: string; setPublicUrl: (v: string) => void;
}): JSX.Element;
```

`NotifySection` gains `settleMs` and the mute props in Task 9. This task is a **pure move**.

- [ ] **Step 1: Record the green baseline**

Run: `bunx bun test tests/settings-view.test.tsx tests/prefs-applied.test.tsx tests/settings-styles.test.ts 2>&1 | tail -6`
Write the pass count down. It must be identical at Step 5.

- [ ] **Step 2: Move the device section**

Create `src/web/components/settings/DeviceSection.tsx` containing the `<section className="settings-section">` for "This device" **verbatim** — the theme select, refresh rate, font size (keep its long comment about empty meaning automatic) and wrap toggle. It takes `prefs` and `setPref` as props and holds no state.

- [ ] **Step 3: Move the Telegram and notify sections**

Create `TelegramSection.tsx` with the token field (keep the `settings-token-status` comment), the chat id field, and — moved up from `settings-actions` — the "Send test message" button plus the `testResult` paragraph. Create `NotifySection.tsx` with the notifications checkbox, the triggers fieldset, the public URL field (keep its comment) and the cooldown field (keep its `min` comment).

The Save button stays in `Settings.tsx` for now; Task 8 moves it into `SaveBar`.

- [ ] **Step 4: Reduce `Settings.tsx` to the shell**

It keeps: all `useState`, `mountedRef`, the GET effect, `setPref`, `toggleTrigger`, `save`, `sendTest`, `tokenPlaceholder`, the header, the banners, and the three section elements. It keeps every fetch — there is still exactly one place that knows how settings reach the server.

- [ ] **Step 5: Verify the baseline is unchanged**

Run: `bunx bun test tests/settings-view.test.tsx tests/prefs-applied.test.tsx tests/settings-styles.test.ts 2>&1 | tail -6`
Expected: the same pass count as Step 1, zero failures. If a test needed editing, the move was not pure — revert that edit and fix the component instead.

- [ ] **Step 6: Commit**

```bash
make check && make test 2>&1 | tail -25
make check-clean
git add -A
git commit -m "refactor: split Settings.tsx into section components

No behaviour change — the same tests pass untouched. The shell keeps
every fetch, so there is still one place that knows how settings reach
the server. Done as its own commit so the next diff is only new UI."
```

---

### Task 8: The sticky save bar and the toast

**Files:**
- Create: `src/web/components/settings/SaveBar.tsx`, `src/web/components/settings/Toast.tsx`
- Modify: `src/web/components/Settings.tsx`, `src/web/styles.css`
- Test: `tests/settings-save-bar.test.tsx` (create), `tests/settings-styles.test.ts`

**Interfaces:**
- Produces:

```ts
export function SaveBar(p: { dirty: boolean; saving: boolean; onSave: () => void }): JSX.Element | null;
export function Toast(p: { message: string | null }): JSX.Element | null;
```

- [ ] **Step 1: Write the failing tests**

Create `tests/settings-save-bar.test.tsx`:

```tsx
// FIRST: React reads `document` at import time.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Settings } from "@web/components/Settings";
import { render, settle, stubFetch, typeInto, unmount } from "./support/render";

const realFetch = globalThis.fetch;
afterEach(async () => { await unmount(); globalThis.fetch = realFetch; });

const view = () => ({
  telegram: { configured: true, hint: "7f21", chatId: "555" },
  notify: {
    enabled: true, triggers: ["blocked"],
    settleMs: { blocked: 5_000, done: 10_000 }, mutedUntil: null, cooldownMs: 60_000,
  },
  publicUrl: null, serverNow: 1_700_000_000_000, error: null,
});

/**
 * `stubFetch` matches by `url.includes(key)` and takes the FIRST key that
 * matches, in object order — and "/api/settings/mute" contains
 * "/api/settings". So wherever both appear, the more specific key MUST come
 * first, or a mute POST is answered with the settings view and the test
 * passes for the wrong reason.
 */
async function mounted() {
  const stub = stubFetch({ "/api/settings": () => view() });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  return { host, stub };
}

test("the save bar is absent until something is dirty", async () => {
  // It costs no screen space while the operator is only reading.
  const { host } = await mounted();
  expect(host.querySelector(".settings-save-bar")).toBeNull();
});

test("editing a field raises the save bar", async () => {
  // The reported problem: Save sat at the bottom of a long form, the operator
  // changed a field near the top, never scrolled, and left believing it took.
  const { host } = await mounted();
  const chatId = host.querySelector<HTMLInputElement>('input[name="chatId"]')!;
  // `typeInto`, never `chatId.value = …`: React installs its own value
  // accessor, and under happy-dom its change plugin ignores a bare `input`
  // event — both failures are SILENT, so the test would assert against the
  // component's original state and read as coverage while providing none.
  // tests/support/render.tsx documents the measurement.
  typeInto(chatId, "999");
  await settle();
  const bar = host.querySelector(".settings-save-bar");
  expect(bar).not.toBeNull();
  expect(bar!.textContent).toContain("Unsaved changes");
});

test("typing a token counts as dirty even though the field starts empty", async () => {
  // The token is write-only, so there is no baseline to compare against —
  // anything typed IS a change.
  const { host } = await mounted();
  const token = host.querySelector<HTMLInputElement>('input[name="token"]')!;
  typeInto(token, "999:BBtyped");
  await settle();
  expect(host.querySelector(".settings-save-bar")).not.toBeNull();
});

test("a successful save clears the bar and announces itself in a live region", async () => {
  const stub = stubFetch({ "/api/settings": () => view() });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const chatId = host.querySelector<HTMLInputElement>('input[name="chatId"]')!;
  typeInto(chatId, "999");
  await settle();
  host.querySelector<HTMLButtonElement>(".settings-save-bar button")!.click();
  await settle();
  await settle();
  const toast = host.querySelector(".settings-toast");
  expect(toast).not.toBeNull();
  expect(toast!.getAttribute("role")).toBe("status");
  expect(toast!.textContent).toContain("saved");
  expect(host.querySelector(".settings-save-bar")).toBeNull();
});

test("a failed save keeps the bar and uses the persistent banner, not the toast", async () => {
  // An error the operator must catch within three seconds is a swallowed
  // error.
  // Hand-rolled rather than stubFetch, because this needs the GET to succeed
  // and the PUT to the SAME path to fail.
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/api/settings") && init?.method === "PUT") {
      return new Response(JSON.stringify({ detail: "chat id must be numeric" }),
        { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(view()), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const chatId = host.querySelector<HTMLInputElement>('input[name="chatId"]')!;
  typeInto(chatId, "nope");
  await settle();
  host.querySelector<HTMLButtonElement>(".settings-save-bar button")!.click();
  await settle();
  await settle();
  expect(host.querySelector(".settings-toast")).toBeNull();
  expect(host.querySelector(".settings-banner")!.textContent).toContain("chat id must be numeric");
  expect(host.querySelector(".settings-save-bar")).not.toBeNull();
});

test("the test button posts the on-screen token, not an empty body", async () => {
  const stub = stubFetch({
    "/api/settings/telegram/test": () => ({ ok: true, detail: null }),
    "/api/settings": () => view(),
  });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const token = host.querySelector<HTMLInputElement>('input[name="token"]')!;
  typeInto(token, "999:BBtyped");
  await settle();
  const buttons = [...host.querySelectorAll("button")];
  buttons.find((b) => (b.textContent ?? "").includes("test"))!.click();
  await settle();
  await settle();
  const call = stub.calls.find((c) => c.url.includes("/telegram/test"))!;
  expect(call.body).toEqual({ token: "999:BBtyped", chatId: "555" });
});
```

Append to `tests/settings-styles.test.ts`:

```ts
test("the save bar clears the home indicator", () => {
  // A fixed bar with no safe-area padding puts Save under the iOS gesture bar.
  expect(declaration(".settings-save-bar", "padding-bottom")).toContain("env(safe-area-inset-bottom)");
});

test("reserving space for the bar does not cost the page its safe-area inset", () => {
  // `.settings` is a later rule than `.safe-bottom` at equal specificity, so a
  // bare padding-bottom here would override the inset for the whole page.
  expect(declaration(".settings", "padding-bottom")).toContain("env(safe-area-inset-bottom");
});

test("the save bar's button is a full touch target", () => {
  expect(declaration(".settings-save-bar button", "min-height")).toBe(TOUCH_TARGET);
});

test("the toast does not animate under reduced motion", () => {
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  expect(reduced).toContain(".settings-toast");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx bun test tests/settings-save-bar.test.tsx 2>&1 | tail -20`
Expected: FAIL — `.settings-save-bar` is null after an edit.

- [ ] **Step 3: Write the two components**

`src/web/components/settings/SaveBar.tsx`:

```tsx
interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}

/**
 * Renders NOTHING when the form is clean.
 *
 * Save used to sit at the bottom of a long single-column form: on a phone the
 * operator changed a field near the top, never scrolled, and left believing
 * the change had taken. A bar that appears the moment anything is dirty is
 * both the reminder and the button, and costs no screen space while the
 * operator is only reading.
 */
export function SaveBar({ dirty, saving, onSave }: SaveBarProps) {
  if (!dirty) return null;
  return (
    <div className="settings-save-bar" role="region" aria-label="Unsaved changes">
      <span>Unsaved changes</span>
      <button type="button" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
```

`src/web/components/settings/Toast.tsx`:

```tsx
interface ToastProps {
  /** Null hides it. Success text only — see below. */
  message: string | null;
}

/**
 * Success only, and deliberately.
 *
 * Errors keep the persistent `settings-banner`: an error the operator has to
 * catch inside a three-second window is a swallowed error, and this codebase's
 * central rule is that failures are surfaced. A live region rather than plain
 * text so the confirmation reaches a screen reader without stealing focus.
 */
export function Toast({ message }: ToastProps) {
  if (message === null) return null;
  return <p className="settings-toast" role="status" aria-live="polite">{message}</p>;
}
```

- [ ] **Step 4: Track dirtiness in the shell**

In `Settings.tsx`, add a baseline and derive dirtiness. Capture it from the GET and from each successful PUT:

```tsx
/** The server state the form was last known to match. Dirtiness is measured
 *  against this, so it is re-captured on every successful save. */
const [baseline, setBaseline] = useState<SettingsView | null>(null);
const [savedAt, setSavedAt] = useState<number | null>(null);

// Token is write-only: the field always starts empty and the server never
// sends one back, so there is no baseline to compare — anything typed is a
// change.
const dirty =
  baseline !== null && (
    token !== "" ||
    chatId !== (baseline.telegram.chatId ?? "") ||
    notifyEnabled !== baseline.notify.enabled ||
    triggers.join(",") !== [...baseline.notify.triggers].join(",") ||
    cooldownMs !== baseline.notify.cooldownMs ||
    publicUrl !== (baseline.publicUrl ?? "")
  );
```

`setBaseline(body)` goes next to every existing `setView(body)`. In `save()`, on success also `setSavedAt(Date.now())`.

The toast auto-dismisses on a timer that is cleared on unmount:

```tsx
// Cleared on unmount, and keyed on `savedAt` so two saves in a row each get
// a full three seconds rather than the second inheriting the first's timer.
useEffect(() => {
  if (savedAt === null) return;
  const t = setTimeout(() => setSavedAt(null), 3_000);
  return () => clearTimeout(t);
}, [savedAt]);
```

Render `<Toast message={savedAt === null ? null : "Settings saved"} />` after the banners, and `<SaveBar dirty={dirty} saving={saving} onSave={() => void save()} />` as the last child of `<main>`. Delete the old `.settings-actions` Save button; the test button already moved to `TelegramSection` in Task 7.

Keep the existing "a form that never loaded cannot be saved" guard: `dirty` is false while `baseline === null`, which achieves the same thing structurally — note that in a comment where the old `disabled={... || view === null}` used to be.

- [ ] **Step 5: Send the typed credentials from `sendTest`**

```tsx
  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/telegram/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The values ON SCREEN, so a pasted token can be verified before it is
        // committed. Blank fields are omitted, and the server falls back to
        // the stored value per field.
        body: JSON.stringify({
          ...(token ? { token } : {}),
          ...(chatId ? { chatId } : {}),
        }),
      });
      const body = (await res.json()) as { ok: boolean; detail: string | null };
      if (mountedRef.current) setTestResult(body);
    } catch (e) {
      if (mountedRef.current) {
        setTestResult({ ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (mountedRef.current) setTesting(false);
    }
  }
```

- [ ] **Step 6: Add the CSS**

In `src/web/styles.css`, after the existing `.settings-*` rules:

```css
.settings-save-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  padding-bottom: calc(0.6rem + env(safe-area-inset-bottom));
  background: var(--surface);
  border-top: 1px solid var(--border);
  color: var(--fg);
}

.settings-save-bar button { min-height: 2.75rem; padding-inline: 1.25rem; }

/* Reserved unconditionally, so the bar appearing never covers the last field
   and nothing on the page jumps when it does.
   `calc(... + env(...))`, not a bare 5.5rem: `<main>` already carries
   `.safe-bottom` (styles.css:84), which sets `padding-bottom:
   env(safe-area-inset-bottom)`. `.settings` is the LATER rule at equal
   specificity, so a bare value here would win and silently drop the home-
   indicator inset from the whole page. Merge this into the existing
   `.settings` rule at styles.css:533 rather than adding a second one. */
.settings { padding-bottom: calc(5.5rem + env(safe-area-inset-bottom, 0px)); }

.settings-toast {
  position: sticky;
  top: 0.5rem;
  margin: 0.5rem 0;
  padding: 0.55rem 0.8rem;
  border-radius: 0.4rem;
  background: var(--surface);
  border: 1px solid var(--ok);
  color: var(--ok);
  transition: opacity 150ms ease-in;
}

@media (prefers-reduced-motion: reduce) {
  .settings-toast { transition: none; }
}
```

Every colour above is an existing token, so nothing new needs defining on `:root`.

- [ ] **Step 7: Run to verify it passes**

Run: `bunx bun test tests/settings-save-bar.test.tsx tests/settings-styles.test.ts tests/settings-view.test.tsx tests/tokens.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
make check && make test 2>&1 | tail -25
make check-clean
git add -A
git commit -m "feat: a sticky save bar and a success toast

Save sat at the bottom of a long form and was missed. A bar now appears
the moment anything is dirty. Errors keep the persistent banner — an
error that must be caught within three seconds is a swallowed one.

The test button also sends the on-screen credentials now."
```

---

### Task 9: Mute and settle in the UI

**Files:**
- Modify: `src/web/components/settings/NotifySection.tsx`, `src/web/components/Settings.tsx`, `src/web/styles.css`
- Test: `tests/settings-save-bar.test.tsx`, `tests/settings-styles.test.ts`

**Interfaces:**
- Consumes: `POST /api/settings/mute` (Task 6), `SettingsView.settleMs` / `.mutedUntil` / `.serverNow` (Task 1).
- Produces: `NotifySection` additionally takes `settleMs: Record<NotifyTrigger, number>`, `setSettleMs: (t: NotifyTrigger, ms: number) => void`, `mutedUntil: number | null`, `serverNow: number`, `onMute: (forMs: number) => void`, `muting: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/settings-save-bar.test.tsx`:

```tsx
test("mute applies immediately and does not go through Save", async () => {
  // The operator taps Mute because they are going to bed, not because they
  // intend to hunt for a Save button.
  const stub = stubFetch({
    "/api/settings/mute": () => ({ ...view(), notify: { ...view().notify, mutedUntil: 1_700_000_000_000 + 3_600_000 } }),
    "/api/settings": () => view(),
  });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  host.querySelector<HTMLButtonElement>('button[name="mute-1h"]')!.click();
  await settle();
  await settle();
  const call = stub.calls.find((c) => c.url.includes("/api/settings/mute"))!;
  expect(call.body).toEqual({ forMs: 3_600_000 });
  // A mute is not an unsaved edit.
  expect(host.querySelector(".settings-save-bar")).toBeNull();
});

test("a muted dashboard says until when, computed from the server's clock", async () => {
  const muted = {
    ...view(),
    notify: { ...view().notify, mutedUntil: 1_700_000_000_000 + 3_600_000 },
  };
  const stub = stubFetch({ "/api/settings": () => muted });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const el = host.querySelector(".settings-mute")!;
  expect(el.textContent).toContain("Muted until");
  expect(el.querySelector('button[name="unmute"]')).not.toBeNull();
});

test("unmute posts a zero duration", async () => {
  const muted = { ...view(), notify: { ...view().notify, mutedUntil: 1_700_000_000_000 + 3_600_000 } };
  const stub = stubFetch({ "/api/settings/mute": () => view(), "/api/settings": () => muted });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  host.querySelector<HTMLButtonElement>('button[name="unmute"]')!.click();
  await settle();
  await settle();
  expect(stub.calls.find((c) => c.url.includes("/mute"))!.body).toEqual({ forMs: 0 });
});

test("a settle window is edited in seconds and saved in milliseconds", async () => {
  const stub = stubFetch({ "/api/settings": () => view() });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();
  const done = host.querySelector<HTMLInputElement>('input[name="settle-done"]')!;
  expect(done.value).toBe("10");
  typeInto(done, "30");
  await settle();
  host.querySelector<HTMLButtonElement>(".settings-save-bar button")!.click();
  await settle();
  await settle();
  const put = stub.calls.find((c) => c.url.includes("/api/settings") && !c.url.includes("/mute"))!;
  expect((put.body as { notify: { settleMs: unknown } }).notify.settleMs)
    .toEqual({ blocked: 5_000, done: 30_000 });
});
```

Append to `tests/settings-styles.test.ts`:

```ts
test("the mute buttons are full touch targets", () => {
  expect(declaration(".settings-mute button", "min-height")).toBe(TOUCH_TARGET);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx bun test tests/settings-save-bar.test.tsx 2>&1 | tail -20`
Expected: FAIL — no `button[name="mute-1h"]`.

- [ ] **Step 3: Add the state and the mute call to the shell**

In `Settings.tsx`:

```tsx
const [settleMs, setSettleMsState] = useState<Record<NotifyTrigger, number>>({ blocked: 5_000, done: 10_000 });
const [mutedUntil, setMutedUntil] = useState<number | null>(null);
const [serverNow, setServerNow] = useState(0);
const [muting, setMuting] = useState(false);

const setSettleMs = (t: NotifyTrigger, ms: number) =>
  setSettleMsState((cur) => ({ ...cur, [t]: ms }));
```

Seed all three from the GET response alongside the existing seeds, and include `settleMs` in the patch built by `save()`. Add `settleMs` to the `dirty` comparison:

```tsx
    settleMs.blocked !== baseline.notify.settleMs.blocked ||
    settleMs.done !== baseline.notify.settleMs.done ||
```

The mute handler is its own request, and applies at once:

```tsx
  /**
   * Its own request, not part of the form. The server stamps the instant from
   * this duration — a phone's clock is not the server's — and mute takes
   * effect immediately, because the operator taps it on their way to bed.
   */
  async function mute(forMs: number) {
    setMuting(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings/mute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forMs }),
      });
      const body = await res.json();
      if (!mountedRef.current) return;
      if (!res.ok) {
        setSaveError(typeof body?.detail === "string" ? body.detail : `mute failed: ${res.status}`);
        return;
      }
      const v = body as SettingsView;
      setView(v);
      setMutedUntil(v.notify.mutedUntil);
      setServerNow(v.serverNow);
      // Deliberately NOT setBaseline: mute is not one of the form's fields,
      // so it must neither create nor clear unsaved changes.
    } catch (e) {
      if (mountedRef.current) setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setMuting(false);
    }
  }
```

- [ ] **Step 4: Render mute and the settle inputs**

At the top of `NotifySection`:

```tsx
const HOUR_MS = 3_600_000;

/** Server-clock instant rendered as a local wall-clock time. `serverNow` is
 *  the server's reading at load; the offset from the device's clock is applied
 *  once so a skewed phone still shows a sane countdown.
 *
 *  Deliberately NOT a live ticker. A per-second re-render of the settings
 *  screen to age a label by one minute is not worth a timer, and the label is
 *  recomputed on every render anyway — including after the mute POST returns
 *  a fresh `serverNow`. */
function muteLabel(mutedUntil: number, serverNow: number): string {
  const skew = Date.now() - serverNow;
  const at = new Date(mutedUntil + skew);
  const remaining = Math.max(0, mutedUntil - serverNow);
  const h = Math.floor(remaining / HOUR_MS);
  const m = Math.round((remaining % HOUR_MS) / 60_000);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `Muted until ${clock} (in ${h}h ${m}m)`;
}
```

```tsx
      <div className="settings-mute">
        {mutedUntil !== null && mutedUntil > serverNow ? (
          <>
            <span>{muteLabel(mutedUntil, serverNow)}</span>
            <button type="button" name="unmute" disabled={muting} onClick={() => onMute(0)}>
              Unmute
            </button>
          </>
        ) : (
          <>
            <span>Mute for</span>
            {([1, 4, 8] as const).map((h) => (
              <button
                key={h}
                type="button"
                name={`mute-${h}h`}
                disabled={muting}
                onClick={() => onMute(h * HOUR_MS)}
              >
                {h}h
              </button>
            ))}
          </>
        )}
      </div>
```

There is deliberately no "mute indefinitely" button: `notify.enabled` is already that control, and two controls for one state is how an operator ends up muted without knowing why.

Inside the existing triggers fieldset, after each checkbox label:

```tsx
          <label className="settings-settle">
            wait
            <input
              type="number"
              name="settle-blocked"
              min={0}
              max={600}
              value={Math.round(settleMs.blocked / 1000)}
              onChange={(e) => setSettleMs("blocked", Number(e.target.value) * 1000)}
            />
            s before sending
          </label>
```

and the same for `done` with `name="settle-done"`. Below the fieldset:

```tsx
        <p className="settings-hint">
          Only notify once the agent has held this state for the whole wait. A
          subagent finishing flips an agent to done for a moment; waiting means
          you hear about the real finish, not that blip.
        </p>
```

- [ ] **Step 5: Add the CSS**

```css
.settings-mute {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-block: 0.75rem;
  color: var(--fg);
}

.settings-mute button { min-height: 2.75rem; padding-inline: 1rem; }

.settings-settle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--fg-dim);
}

.settings-settle input { width: 4rem; min-height: 2.75rem; }
```

- [ ] **Step 6: Run to verify it passes**

Run: `bunx bun test tests/settings-save-bar.test.tsx tests/settings-styles.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
make check && make test 2>&1 | tail -25
make check-clean
git add -A
git commit -m "feat: mute buttons and per-trigger settle inputs

Mute applies immediately through its own route and is not part of the
form, so it neither creates nor clears unsaved changes. The settle
windows sit next to the trigger they belong to, which is where the
confusion about false finishes actually lives."
```

---

### Task 10: An inline Open button instead of a bare URL

**Files:**
- Modify: `src/server/notify/telegram.ts`, `src/server/notify/notifier.ts`, `src/server/index.ts`, `src/shared/types.ts`
- Test: `tests/telegram.test.ts`, `tests/notifier-settle.test.ts`

**Interfaces:**
- Produces: `InlineKeyboard` in `@shared/types`; `composeMessage(a: Agent, state: AgentState, publicUrl: string | null): { text: string; replyMarkup?: InlineKeyboard }` exported from `notifier.ts`; `SendOpts.replyMarkup?: InlineKeyboard`; `NotifierOpts.send` becomes `(text: string, replyMarkup?: InlineKeyboard) => Promise<{ ok: boolean; detail: string | null }>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/telegram.test.ts`:

```ts
test("reply_markup is sent when given, and omitted when not", async () => {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  await sendTelegram({ token: "1:A", chatId: "555", text: "hi", fetchImpl });
  await sendTelegram({
    token: "1:A", chatId: "555", text: "hi", fetchImpl,
    replyMarkup: { inline_keyboard: [[{ text: "Open in paddock", url: "https://paddock.example.com/#/agent/w1%3Ap1" }]] },
  });

  expect("reply_markup" in (bodies[0] as object)).toBe(false);
  expect((bodies[1] as { reply_markup: unknown }).reply_markup).toEqual({
    inline_keyboard: [[{ text: "Open in paddock", url: "https://paddock.example.com/#/agent/w1%3Ap1" }]],
  });
});
```

Append to `tests/notifier-settle.test.ts`:

```ts
import { composeMessage } from "@server/notify/notifier";

test("an https public URL becomes a button, and the text carries no link", async () => {
  const m = composeMessage(agent(), "done", "https://paddock.example.com");
  expect(m.text).toBe("api-refactor is done");
  expect(m.replyMarkup).toEqual({
    inline_keyboard: [[{ text: "Open in paddock", url: "https://paddock.example.com/#/agent/w1%3Ap1" }]],
  });
});

test("a trailing slash does not produce a doubled path", async () => {
  const m = composeMessage(agent(), "done", "https://paddock.example.com/");
  expect(m.replyMarkup!.inline_keyboard[0]![0]!.url).toBe("https://paddock.example.com/#/agent/w1%3Ap1");
});

test("a non-https URL falls back to a text link, because Telegram refuses the button", async () => {
  // Telegram answers Button_url_invalid for a non-https inline URL, and a
  // rejected message is worse than a plain link: the operator gets nothing.
  const m = composeMessage(agent(), "done", "http://dev-box:8787");
  expect(m.replyMarkup).toBeUndefined();
  expect(m.text).toBe("api-refactor is done\nhttp://dev-box:8787/#/agent/w1%3Ap1");
});

test("with no public URL the message is text only, and never carries the task", async () => {
  const m = composeMessage(agent({ task: "pasted-secret-in-title" }), "done", null);
  expect(m.text).toBe("api-refactor is done");
  expect(JSON.stringify(m)).not.toContain("pasted-secret");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx bun test tests/telegram.test.ts tests/notifier-settle.test.ts 2>&1 | tail -20`
Expected: FAIL — `composeMessage` is not exported.

- [ ] **Step 3: Add the shared type**

In `src/shared/types.ts`:

```ts
/** A Telegram inline keyboard. Declared in the shared contract because the
 *  notifier composes it and the transport serialises it. */
export interface InlineKeyboard {
  inline_keyboard: { text: string; url: string }[][];
}
```

- [ ] **Step 4: Extract `composeMessage`**

In `src/server/notify/notifier.ts`, above the class:

```ts
/**
 * The message for one settled transition: name, state, and a way in.
 *
 * NOTHING ELSE, and specifically not `a.task` — that is
 * `terminal_title_stripped`, live agent-authored text that may carry a pasted
 * credential. Telegram bot messages are not end-to-end encrypted and Telegram
 * can read them; the design accepts that cost and names content minimalism as
 * the ONLY mitigation for choosing Telegram over Web Push. Adding a field here
 * spends it.
 *
 * The link is an inline button when it can be. Telegram answers
 * `Button_url_invalid` for a non-https button URL, so anything else falls back
 * to a text link — a rejected message would leave the operator with nothing,
 * which is strictly worse than a plain URL.
 */
export function composeMessage(
  a: Agent,
  state: AgentState,
  publicUrl: string | null,
): { text: string; replyMarkup?: InlineKeyboard } {
  const text = `${a.name} is ${state}`;
  if (publicUrl === null || publicUrl === "") return { text };
  // A free-text field collects a trailing slash, and `${url}/${hash}` would
  // then produce "https://host//#/agent/...".
  const url = `${publicUrl.replace(/\/+$/, "")}/${agentHash(a.agentId)}`;
  if (!/^https:\/\//i.test(url)) return { text: `${text}\n${url}` };
  return { text, replyMarkup: { inline_keyboard: [[{ text: "Open in paddock", url }]] } };
}
```

In `#fire`, replace the `link` line and the send call:

```ts
    const m = composeMessage(a, state, s.publicUrl);
    const r = await this.o.send(m.text, m.replyMarkup);
```

Widen `NotifierOpts.send` to `(text: string, replyMarkup?: InlineKeyboard) => Promise<{ ok: boolean; detail: string | null }>`.

- [ ] **Step 5: Carry it through the transport and the composition root**

In `src/server/notify/telegram.ts`:

```ts
export interface SendOpts {
  token: string; chatId: string; text: string;
  /** Omitted from the body entirely when absent — Telegram rejects a null. */
  replyMarkup?: InlineKeyboard;
  fetchImpl?: typeof fetch; timeoutMs?: number;
}
```

and in the body:

```ts
      body: JSON.stringify({
        chat_id: o.chatId,
        text: o.text,
        ...(o.replyMarkup ? { reply_markup: o.replyMarkup } : {}),
      }),
```

In `src/server/index.ts`, widen the `send` closure:

```ts
  send: async (text, replyMarkup) => {
    const s = settings.current();
    if (!isConfigured(s.telegram.token) || !isConfigured(s.telegram.chatId)) {
      return { ok: false, detail: "not configured" };
    }
    return sendTelegram({ token: s.telegram.token, chatId: s.telegram.chatId, text, replyMarkup });
  },
```

- [ ] **Step 6: Run to verify it passes**

Run: `bunx bun test tests/telegram.test.ts tests/notifier-settle.test.ts tests/notifier-timing.test.ts tests/notifier.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
make check && make test 2>&1 | tail -25
make check-clean
git add -A
git commit -m "feat: an Open in paddock button instead of a bare URL

A non-https public URL still gets a text link, because Telegram refuses
a non-https inline button and a rejected message leaves the operator
with nothing. The body still carries name, state and link only."
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/settings.md`, `docs/decisions.md`, `docs/architecture.md:37-43`, `docs/roadmap.md`, `README.md:37`
- Test: `bunx bun test tests/env-docs.test.ts`

- [ ] **Step 1: Rewrite the settings reference**

In `docs/settings.md`, replace the two quiet-hours passages (line 20's field list and line 64's "quiet hours drop rather than queue" bullet):

```markdown
- **notification triggers** (`blocked`, `done`) and a **settle window** per
  trigger — how long the state must hold before a message is sent. `blocked`
  defaults to 5s and `done` to 10s. 0 sends on the state change itself.

- **mute** — silence every notification for 1, 4 or 8 hours. Stored as an
  absolute instant stamped by the server, so it has no timezone to be misread
  by a phone in one zone and a dashboard in another. There is no indefinite
  mute: the Notifications switch is already that control.
```

```markdown
- **a settle window is not a delay, it is a confirmation.** A main agent that
  delegates goes `working → done` the instant a subagent returns, then back to
  `working` when it reviews the result. Notifying on that change produces a
  message that is true when sent and stale when read. Waiting for the state to
  hold means the message describes something that is still the case.

  10s is a starting value. If false finishes persist, raise `done` to 30–60s —
  a main agent that spends 20s composing a review before its status flips back
  is inside 10s but outside nothing longer.

- **mute drops rather than queues** — a pile delivered when mute lifts
  describes agents unblocked hours earlier, which is noise wearing the costume
  of signal.
```

- [ ] **Step 2: Record the two decisions**

Append to `docs/decisions.md`:

```markdown
## Settling a state instead of notifying on the change

Notifying on a state *change* was wrong in a way that only shows up against
real agents: a main agent that delegates goes `working → done` the moment a
subagent finishes, and back to `working` seconds later. Every delegated task
produced a "done" message that was already false when the phone buzzed. The
cooldown does not help — it bounds how *often* paddock speaks, not whether
what it says is still true.

The notifier now arms a per-trigger timer and the next transition cancels it,
so a message is only sent about a state that has held. `blocked` settles in
5s because a blocked agent is waiting on a human; `done` settles in 10s
because `done` is the state that lies.

Two follow-on effects worth knowing. `#lastSeen` split into `#lastSeen` plus
`#lastNotified`, which deleted the optimistic-write-and-revert dance that one
map doing two jobs had required. And the retry became explicit and bounded:
v2 "retried on the next delta", which for a finished agent can never happen,
because a quiet `done` agent produces no further deltas — so a failed finish
notification was simply lost.

## Mute until, rather than quiet hours

Quiet hours was one `HH:MM` range in *server local* time, with no timezone
field and no way to express a second window. An absolute epoch-ms instant
cannot be misread by a phone in one zone and a server in another, and it is
self-describing in the UI: "muted until 07:14" needs no explanation, where
"22:00–08:00" silently invites the question *whose 22:00*.

It also matches when silence is actually wanted — now, because the operator is
going to bed — rather than on a schedule set once and forgotten.

Mute is `POST /api/settings/mute` taking a **duration**, not a patch field
taking an instant, for two reasons: the server stamps the time so a skewed
phone clock cannot set a wrong one, and mute applies immediately while every
other field waits for Save. A separate endpoint makes that structural rather
than a convention. There is no indefinite mute; `notify.enabled` is that
control, and two controls for one state is how an operator ends up muted
without knowing why.
```

- [ ] **Step 3: Update the architecture table**

In `docs/architecture.md`, revise the two rows (lines 41 and 43):

```markdown
| `server/settings/store.ts` | Loads and atomically persists `~/.config/paddock/settings.json` (mode `0600`, override with `PADDOCK_CONFIG_DIR`): the Telegram token/chat id, notification triggers and their settle windows, the mute instant, and the public URL used in a notification's deep link. `migrate()` normalises every stored shape to the current one — explicitly, field by field, because a shallow merge once let a missing settle window mean "fire immediately". `view()` is the only thing routes and the notifier read from it, and it never includes the token itself — only whether one is `configured` and its last four characters. |
| `server/notify/notifier.ts` | Watches deltas for a state **transition**, then arms a per-trigger timer and sends a Telegram message only once that state has **held** for the settle window — the next transition cancels it. Subject to mute and a per-agent cooldown, which defers rather than drops. Owns timers, so it also owns `dispose()`, called from the shutdown path. A leaf off the composition root. `fanOut()` is the small function `index.ts` composes with `hub.queue` so a delta reaches both without either learning the other exists. |
```

- [ ] **Step 4: Record the two findings in the roadmap**

Append to `docs/roadmap.md`'s Backlog:

```markdown
- **A Telegram tap cannot open the iOS PWA, and only Web Push can.**
  Investigated in `docs/design/2026-08-19-notifications-and-settings-design.md`
  §9. iOS opens `https://` links in Safari even when the URL is inside an
  installed web app's scope: there are no `url_handlers`, no protocol handlers
  in Safari, and Universal Links need a native app. Telegram's own `openLink`
  on iOS forces the external browser, making it worse rather than better.

  There is exactly one documented exception: a **Web Push notification from
  the installed PWA opens the PWA** (iOS 16.4+). Two consequences. Safari
  keeps a storage container separate from the Home Screen app, so a Telegram
  tap can mean re-doing a Cloudflare Access login already held in the PWA.
  And the Web Push entry above was retired on the reasoning that Telegram
  "works today on any device" — still true, and this is the evidence on the
  other side of that trade, because push is the only mechanism that lands a
  tap *inside* the app on iOS. What shipped instead is an inline "Open in
  paddock" keyboard button, which is a better tap target and still lands in
  Safari.

- **Spawning an agent from paddock.** Feasible, measured against herdr
  protocol 19, and deliberately unbuilt — see
  `docs/design/2026-08-19-notifications-and-settings-design.md` §10 for the
  full findings. In short: `tab.create` takes
  `{workspace_id?, cwd?, label?, env?, focus}` and `agent.start` takes
  `{name, kind, pane_id, args?, timeout_ms?}` with `kind` a fixed enum
  including `claude`, `codex`, `gemini`, `pi`. Three constraints for whoever
  picks it up. `agent.start` blocks on readiness for up to 30s by default
  while `socket.ts` sets `HERDR_TIMEOUT_MS = 10_000`, so it needs a per-call
  timeout override. `tab.create`'s result shape is not in
  `src/shared/herdr-api.d.ts`, and this repo has already shipped a bug from
  assuming one (`result.text` versus `result.read.text`), so it needs
  `scripts/gen-herdr-types.ts` extended rather than a hand-written literal.
  And it would be paddock's first **creating** action — every action today
  drives an agent that already exists — which deserves its own decisions
  about permitted kinds and where `cwd` may point.
```

- [ ] **Step 5: Fix the README's one-liner**

`README.md:37`:

```markdown
- **notify** — a Telegram message when an agent needs you, sent only once the
  state has held, with mute and a per-agent cooldown. [settings →](docs/settings.md)
```

- [ ] **Step 6: Verify and commit**

Run: `make check && make test 2>&1 | tail -25`
Expected: PASS — `tests/env-docs.test.ts` checks docs against `.env.example`, so a stale reference fails here.

```bash
make check-clean
git add -A
git commit -m "docs: settling, mute, and two recorded findings

Records why a state is settled rather than notified on change, and why
mute replaced quiet hours. Also records that a Telegram tap cannot open
an iOS PWA (only Web Push can) and that spawning an agent via
tab.create + agent.start is feasible but needs its own design."
```

---

## Verification before calling this done

Run the whole gate from a clean tree, and read the output rather than assuming it:

```bash
make check
make check-clean
make test
make build
```

Then exercise it by hand, because the settle window is a timing behaviour and no unit test proves the real timers fire:

1. `make dev`, open Settings, paste a bad token, press **Send test message** — expect a Telegram error, not "token and chat id must both be set".
2. Fix the token, test again, confirm the bar still says **Unsaved changes**, then Save and watch for the toast.
3. Set `done` settle to 10s. Drive an agent through `working → done → working` inside 10s and confirm **no** message arrives. Let one finish and stay finished, and confirm one does.
4. Tap **Mute 1h**, confirm the label shows a countdown, and confirm a blocked agent sends nothing.
5. Confirm the Telegram message shows an **Open in paddock** button and that tapping it reaches the right agent.
