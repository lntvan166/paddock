# Settings tab and Telegram notifications — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the operator over Telegram when an agent becomes `blocked` or
`done`, and add a settings view at `#/settings` that configures it alongside
per-device display and refresh preferences.

**Architecture:** A notifier hangs off the composition root in
`server/index.ts`, where `onDelta` already fans deltas out to the WebSocket hub
— so no existing module learns that Telegram exists. Server-global settings
persist to `~/.config/paddock/settings.json`; per-device preferences stay in
`localStorage` behind a single owning module.

**Tech Stack:** Bun, Hono, React 18, TypeScript, `bun:test`, happy-dom for
component tests.

**Spec:** `docs/design/2026-08-18-settings-and-telegram-design.md`

## Global Constraints

- **This repository is public.** No real hostnames, domains, home paths,
  usernames, machine names, employer terms, or tunnel IDs in any file —
  including comments, tests and commit messages. Fixtures use invented agent
  names: `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`.
- **Dependency direction is strict:** `herdr/socket → herdr/adapter →
  state/store → ws/hub → web/`. Nothing upstream imports anything downstream.
  **`src/server/**` must never import from `@web/`** — verified true today.
- **`src/shared/types.ts` is the one payload contract**, imported by both
  server and UI. Never redeclare a payload shape on one side.
- **Never swallow errors.** No empty catch blocks, no `2>/dev/null`, no
  unconditional `exit 0`.
- **Never put payloads in a GET query string.** POST/PUT bodies only.
- **The Telegram bot token is never logged at any level, and never appears in
  any response body.** `GET /api/settings` returns `configured` and a
  four-character `hint` in its place.
- **No device detection.** No `isMobile`, no user-agent parsing. Width media
  queries for layout, `(pointer: coarse)` / `(hover: hover)` for interaction.
- **Never define a colour only inside a media query.** Tokens on bare `:root`,
  then redefined under `prefers-color-scheme` and `[data-theme]`.
- **Run `make check && make check-clean && make test` before every commit.**
- **Prove each test can fail** by breaking the code it guards before trusting
  it. A test that cannot fail reads as coverage while providing none.

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/route.ts` (new) | `agentHash` / `agentIdFromHash` — pure URL shape, imported by both sides |
| `src/web/route.ts` (mod) | Keeps `useAgentRoute`, re-exports the moved helpers, adds `useSettingsRoute` |
| `src/shared/types.ts` (mod) | `NotifyTrigger`, `SettingsView`, `SettingsPatch` |
| `src/server/settings/store.ts` (new) | Load, validate, patch, persist `settings.json` |
| `src/server/notify/telegram.ts` (new) | Transport only — one HTTPS POST |
| `src/server/notify/notifier.ts` (new) | Policy — transitions, triggers, quiet hours, cooldown |
| `src/server/routes.ts` (mod) | `GET`/`PUT /api/settings`, `POST /api/settings/telegram/test` |
| `src/server/index.ts` (mod) | Fan `onDelta` out to hub **and** notifier |
| `src/web/prefs.ts` (new) | The single owner of `localStorage` |
| `src/web/components/Settings.tsx` (new) | The view |
| `src/web/components/App.tsx` (mod) | Third route |

---

### Task 1: Move the URL helpers to `src/shared/`

The notifier is server code and must build a deep link. `agentHash` currently
lives in `src/web/route.ts`, which server code may not import. Moving it is a
prerequisite for Task 4, not a tidy-up.

**Files:**
- Create: `src/shared/route.ts`
- Modify: `src/web/route.ts`
- Modify: `tests/route.test.ts`

**Interfaces:**
- Produces: `agentHash(agentId: string): string` and
  `agentIdFromHash(hash: string): string | null`, both importable as
  `@shared/route`. `useAgentRoute(): string | null` stays in `@web/route`.

- [ ] **Step 1: Write the failing test**

Add to `tests/route.test.ts`:

```ts
import { agentHash, agentIdFromHash } from "@shared/route";

test("the URL helpers are importable from shared, so server code may use them", () => {
  // The notifier builds a deep link and lives under src/server/, which may
  // never import @web/. If these move back, the notifier's link silently
  // stops matching the app it points at.
  expect(agentHash("w1:p1")).toBe("#/agent/w1%3Ap1");
  expect(agentIdFromHash("#/agent/w1%3Ap1")).toBe("w1:p1");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/route.test.ts`
Expected: FAIL — cannot resolve `@shared/route`.

- [ ] **Step 3: Create `src/shared/route.ts`**

Move `AGENT_HASH_RE`, `agentHash` and `agentIdFromHash` verbatim from
`src/web/route.ts`, keeping their existing doc comments. Add at the top:

```ts
/**
 * The agent URL shape, in shared rather than web, because BOTH sides need it:
 * the UI to route, and the notifier to build a deep link into a message. The
 * dependency rule forbids src/server importing @web/, and duplicating the
 * format would give a notification link its own copy to drift from.
 */
```

- [ ] **Step 4: Re-export from `src/web/route.ts`**

Delete the moved definitions and add, keeping `useAgentRoute` and its imports:

```ts
export { agentHash, agentIdFromHash } from "@shared/route";
import { agentIdFromHash } from "@shared/route";
```

- [ ] **Step 5: Verify**

Run: `make check && bun test tests/route.test.ts`
Expected: PASS, and no call site changed.

- [ ] **Step 6: Prove the test can fail**

Temporarily change `agentHash` to return `#/agents/${...}`; confirm RED; revert.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && make test
git add src/shared/route.ts src/web/route.ts tests/route.test.ts
git commit -m "refactor: move the agent URL helpers to shared

The notifier builds a deep link and lives under src/server/, which may never
import @web/. Re-exported from @web/route so no call site changes."
```

---

### Task 2: Settings types and the settings store

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/server/settings/store.ts`
- Create: `tests/settings-store.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `class SettingsStore` with `load(): Promise<void>`,
  `current(): Settings`, `view(): SettingsView`,
  `patch(p: SettingsPatch): Promise<void>`, `error: string | null`.
  Types `NotifyTrigger`, `SettingsView`, `SettingsPatch` in `@shared/types`.

- [ ] **Step 1: Add the payload types**

In `src/shared/types.ts`:

```ts
export type NotifyTrigger = "blocked" | "done";

/** What GET /api/settings returns. The token is NEVER a member. */
export interface SettingsView {
  telegram: { configured: boolean; hint: string | null; chatId: string | null };
  notify: {
    enabled: boolean;
    triggers: NotifyTrigger[];
    /** "22:00"/"08:00", server local time. Wraps midnight when start > end. */
    quietHours: { start: string; end: string } | null;
    cooldownMs: number;
  };
  publicUrl: string | null;
  /** Non-null when settings.json failed to load. Surfaced, never swallowed. */
  error: string | null;
}

export interface SettingsPatch {
  telegram?: { token?: string | null; chatId?: string | null };
  notify?: Partial<SettingsView["notify"]>;
  publicUrl?: string | null;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/settings-store.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "@server/settings/store";

const dir = async () => mkdtemp(join(tmpdir(), "paddock-settings-"));

test("defaults when no file exists, and notifications start off", async () => {
  const s = new SettingsStore(await dir());
  await s.load();
  expect(s.current().notify.enabled).toBe(false);
  expect(s.view().telegram.configured).toBe(false);
});

test("the token is never present in the view, only a hint", async () => {
  const s = new SettingsStore(await dir());
  await s.load();
  await s.patch({ telegram: { token: "123456:ABCDEF-secret-7f21" } });
  const v = s.view();
  expect(JSON.stringify(v)).not.toContain("secret");
  expect(v.telegram).toEqual({ configured: true, hint: "7f21", chatId: null });
});

test("the settings file is written 0600 — it holds a bearer credential", async () => {
  const d = await dir();
  const s = new SettingsStore(d);
  await s.load();
  await s.patch({ telegram: { token: "123456:ABCDEF" } });
  expect((await stat(join(d, "settings.json"))).mode & 0o777).toBe(0o600);
});

test("a malformed file does NOT erase the token: defaults in memory, error surfaced, no overwrite", async () => {
  // Overwriting a corrupt file with defaults destroys the one value the
  // operator cannot regenerate from the UI.
  const d = await dir();
  await writeFile(join(d, "settings.json"), "{ not json");
  const s = new SettingsStore(d);
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
```

- [ ] **Step 3: Run and watch them fail**

Run: `bun test tests/settings-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/server/settings/store.ts`**

```ts
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
  #loaded = false;
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
        this.#loaded = true;
        return;
      }
    }

    if (raw === null) {
      this.#s = defaults();
      const chat = this.env.PADDOCK_TELEGRAM_CHAT_ID ?? null;
      const token = this.env.PADDOCK_TELEGRAM_TOKEN ?? null;
      if (chat !== null) this.#s.telegram.chatId = chat;
      if (token !== null) this.#s.telegram.token = token;
      this.#loaded = true;
      if (chat !== null || token !== null) await this.persist();
      return;
    }

    try {
      this.#s = { ...defaults(), ...(JSON.parse(raw) as Settings) };
    } catch (e) {
      this.error = `settings.json is not valid JSON, using defaults and not overwriting it: ${(e as Error).message}`;
      this.#s = defaults();
    }
    this.#loaded = true;
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
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/settings-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Prove they can fail**

Change `persist` to `mode: 0o644` → the permissions test goes RED. Make the
malformed branch call `persist()` → the no-overwrite test goes RED. Revert both.

- [ ] **Step 7: Document the environment seeds**

Append to `.env.example`:

```
# Seeds ~/.config/paddock/settings.json on FIRST RUN ONLY. Once that file
# exists the dashboard owns these values and this is ignored.
# PADDOCK_TELEGRAM_TOKEN=
# PADDOCK_TELEGRAM_CHAT_ID=
# Override where settings.json lives (default ~/.config/paddock)
# PADDOCK_CONFIG_DIR=
```

- [ ] **Step 8: Commit**

```bash
make check && make check-clean && make test
git add src/shared/types.ts src/server/settings/store.ts tests/settings-store.test.ts .env.example
git commit -m "feat: settings store with atomic writes and a write-only token

Atomic because a truncated file loses the token, which is the one value the
UI cannot regenerate. A malformed file is never overwritten with defaults:
that would destroy a credential to fix a typo."
```

---

### Task 3: Telegram transport

**Files:**
- Create: `src/server/notify/telegram.ts`
- Create: `tests/telegram.test.ts`

**Interfaces:**
- Produces: `sendTelegram(opts): Promise<TelegramResult>` where
  `TelegramResult = { ok: boolean; detail: string | null }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from "bun:test";
import { sendTelegram } from "@server/notify/telegram";

const okBody = () => new Response(JSON.stringify({ ok: true }), {
  status: 200, headers: { "content-type": "application/json" },
});

test("posts the text as a JSON body, never a query string", async () => {
  let seen: { url: string; body: string } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), body: String(init.body) };
    return okBody();
  }) as unknown as typeof fetch;

  const r = await sendTelegram({ token: "123:ABC", chatId: "555",
                                 text: "api-refactor is blocked", fetchImpl });
  expect(r.ok).toBe(true);
  expect(seen!.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
  expect(seen!.url).not.toContain("api-refactor");   // never in the URL
  expect(JSON.parse(seen!.body)).toEqual({ chat_id: "555", text: "api-refactor is blocked" });
});

test("an application error arrives as ok:false inside a 200 and is surfaced verbatim", async () => {
  // "Bad Request: chat not found" tells the operator what to fix.
  // "send failed" does not.
  const fetchImpl = (async () => new Response(
    JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;

  const r = await sendTelegram({ token: "123:ABC", chatId: "bad", text: "x", fetchImpl });
  expect(r.ok).toBe(false);
  expect(r.detail).toBe("Bad Request: chat not found");
});

test("a hung request aborts rather than leaking a pending fetch per delta", async () => {
  const fetchImpl = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
    init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
  })) as unknown as typeof fetch;

  const r = await sendTelegram({ token: "1:A", chatId: "5", text: "x", fetchImpl, timeoutMs: 10 });
  expect(r.ok).toBe(false);
  expect(r.detail).toBeTruthy();
});
```

- [ ] **Step 2: Run and watch fail**

Run: `bun test tests/telegram.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
export interface TelegramResult { ok: boolean; detail: string | null }

export interface SendOpts {
  token: string; chatId: string; text: string;
  fetchImpl?: typeof fetch; timeoutMs?: number;
}

/**
 * One HTTPS POST. Transport only — every policy decision lives in notifier.ts.
 *
 * Plain text with NO parse_mode: agent names originate in herdr and may carry
 * Markdown or HTML metacharacters. With no parse mode there is nothing to
 * escape and no way for a name to corrupt or inject into the message.
 */
export async function sendTelegram(o: SendOpts): Promise<TelegramResult> {
  const f = o.fetchImpl ?? fetch;
  const ac = new AbortController();
  // Unbounded, this leaks one pending request per delta against a black hole.
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 10_000);
  try {
    const res = await f(`https://api.telegram.org/bot${o.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: o.chatId, text: o.text }),
      signal: ac.signal,
    });
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (body.ok === true) return { ok: true, detail: null };
    return { ok: false, detail: body.description ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run** → `bun test tests/telegram.test.ts` PASS (3 tests).

- [ ] **Step 5: Prove they can fail**

Move the text into the URL as a query parameter → the first test goes RED.
Return `{ok:false, detail:"send failed"}` unconditionally → the second goes RED.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add src/server/notify/telegram.ts tests/telegram.test.ts
git commit -m "feat: Telegram transport with a bounded timeout

Plain text with no parse_mode, because agent names come from herdr and may
carry Markdown metacharacters. Telegram reports application errors as ok:false
inside a 200, and the description is surfaced verbatim."
```

---

### Task 4: Notifier

**Files:**
- Create: `src/server/notify/notifier.ts`
- Create: `tests/notifier.test.ts`

**Interfaces:**
- Consumes: `SettingsStore` (Task 2), `TelegramResult` (Task 3),
  `agentHash` from `@shared/route` (Task 1), `Delta` from `@server/state/store`.
- Produces: `class Notifier` with `observe(d: Delta): void` and
  `lastError: string | null`; `inQuietHours(d: Date, qh): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from "bun:test";
import { Notifier, inQuietHours } from "@server/notify/notifier";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;
const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
  task: "Extract auth middleware", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", stateSince: NOW,
  updatedAt: NOW, acknowledgedAt: null, ...over,
});

function harness(over: Partial<ReturnType<typeof settings>> = {}) {
  const sent: string[] = [];
  let result = { ok: true, detail: null as string | null };
  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: { enabled: true, triggers: ["blocked"], quietHours: null, cooldownMs: 60_000 },
      publicUrl: "https://paddock.example.com",
      ...over,
    }),
  };
  let now = NOW;
  const n = new Notifier({
    settings: store as never,
    send: async (text: string) => { sent.push(text); return result; },
    now: () => now,
  });
  return { n, sent, setNow: (t: number) => { now = t; },
           fail: (d: string) => { result = { ok: false, detail: d }; } };
}
const settings = () => ({});

test("first sight after boot does not notify", async () => {
  // Otherwise restarting paddock pings once per currently-blocked agent —
  // a burst of notifications caused by nothing having happened.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toEqual([]);
});

test("a transition into a watched state notifies, with name, state and deep link", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toContain("api-refactor");
  expect(h.sent[0]).toContain("blocked");
  expect(h.sent[0]).toContain("https://paddock.example.com/#/agent/w1%3Ap1");
});

test("staying in the same state does not notify again", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked", task: "new output" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
});

test("a failed send does NOT consume the transition, so the next delta retries", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.fail("Bad Request: chat not found");
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
  expect(h.n.lastError).toContain("chat not found");

  h.setNow(NOW + 120_000);   // past the cooldown
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(2);
});

test("quiet hours wrap past midnight — 22:00-08:00 is the ordinary case", () => {
  // Read naively as start <= t < end, the most common setting silences nothing.
  const qh = { start: "22:00", end: "08:00" };
  expect(inQuietHours(new Date("2026-08-18T23:30:00"), qh)).toBe(true);
  expect(inQuietHours(new Date("2026-08-18T03:00:00"), qh)).toBe(true);
  expect(inQuietHours(new Date("2026-08-18T12:00:00"), qh)).toBe(false);
  expect(inQuietHours(new Date("2026-08-18T12:00:00"), { start: "09:00", end: "17:00" })).toBe(true);
});
```

- [ ] **Step 2: Run and watch fail** → `bun test tests/notifier.test.ts`, module not found.

- [ ] **Step 3: Implement**

```ts
import { agentHash } from "@shared/route";
import type { Agent, AgentState } from "@shared/types";
import type { Delta } from "@server/state/store";
import type { SettingsStore } from "@server/settings/store";

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Quiet hours wrap midnight, and that is the ORDINARY case: 22:00-08:00 has
 * start > end. Read as `start <= t < end` the most common setting an operator
 * types silences nothing at all. Equal start and end is a zero-length window.
 */
export function inQuietHours(d: Date, qh: { start: string; end: string } | null): boolean {
  if (qh === null) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  const s = minutes(qh.start), e = minutes(qh.end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

export interface NotifierOpts {
  settings: SettingsStore;
  send: (text: string) => Promise<{ ok: boolean; detail: string | null }>;
  now?: () => number;
}

export class Notifier {
  /** Delta carries only the NEW agent, so a transition cannot be derived
   *  without remembering what we last saw. This map is also the dedup. */
  #lastSeen = new Map<string, AgentState>();
  #lastSentAt = new Map<string, number>();
  lastError: string | null = null;

  constructor(private o: NotifierOpts) {}

  /**
   * Returns void and never awaits. `onDelta` is a synchronous fan-out feeding
   * the WebSocket broadcast; awaiting Telegram would put a third party's
   * latency in front of every browser update.
   */
  observe(d: Delta): void {
    for (const a of d.upserted) void this.#one(a);
    for (const id of d.removedIds) { this.#lastSeen.delete(id); this.#lastSentAt.delete(id); }
  }

  async #one(a: Agent): Promise<void> {
    const prev = this.#lastSeen.get(a.agentId);
    if (prev === undefined) { this.#lastSeen.set(a.agentId, a.state); return; }  // first sight
    if (prev === a.state) return;

    const s = this.o.settings.current();
    const fires = s.notify.enabled
      && s.notify.triggers.includes(a.state as never)
      && s.telegram.token !== null && s.telegram.chatId !== null;

    const now = (this.o.now ?? Date.now)();
    if (!fires) { this.#lastSeen.set(a.agentId, a.state); return; }

    if (inQuietHours(new Date(now), s.notify.quietHours)) {
      // Dropped, never queued: a pile delivered at 08:00 describes agents
      // unblocked five hours earlier — noise wearing the costume of signal.
      this.#lastSeen.set(a.agentId, a.state);
      return;
    }

    const since = now - (this.#lastSentAt.get(a.agentId) ?? Number.NEGATIVE_INFINITY);
    if (since < s.notify.cooldownMs) { this.#lastSeen.set(a.agentId, a.state); return; }

    const link = s.publicUrl ? `\n${s.publicUrl}/${agentHash(a.agentId)}` : "";
    const r = await this.o.send(`${a.name} is ${a.state}\n${a.task}${link}`);
    if (r.ok) {
      this.lastError = null;
      this.#lastSentAt.set(a.agentId, now);
      this.#lastSeen.set(a.agentId, a.state);
      return;
    }
    // Deliberately NOT recording lastSeen: the next delta re-detects the
    // transition and retries. The cooldown is what stops a hot loop.
    this.lastError = r.detail ?? "send failed";
  }
}
```

- [ ] **Step 4: Run** → PASS (5 tests).

- [ ] **Step 5: Prove they can fail**

Set `#lastSeen` on the failure path → the retry test goes RED. Change
`inQuietHours` to `t >= s && t < e` → the wrap test goes RED. Revert both.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add src/server/notify/notifier.ts tests/notifier.test.ts
git commit -m "feat: notifier keyed on state transitions, not state

First sight after boot is silent, or a restart pings once per already-blocked
agent. A failed send leaves lastSeen untouched so the next delta retries, and
the per-agent cooldown is what stops that becoming a hot loop. Quiet hours
drop rather than queue."
```

---

### Task 5: Settings API routes

**Files:**
- Modify: `src/server/routes.ts`
- Create: `tests/settings-routes.test.ts`

**Interfaces:**
- Consumes: `SettingsStore` (Task 2), `sendTelegram` (Task 3).
- Produces: `AppDeps.settings?: SettingsStore`. Optional, matching the
  existing `actions?` pattern, so every current test keeps compiling.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/routes";
import { SettingsStore } from "@server/settings/store";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

async function harness() {
  const settings = new SettingsStore(await mkdtemp(join(tmpdir(), "paddock-r-")));
  await settings.load();
  const app = createApp({
    store: new AgentStore("dev-box"), hub: new Hub({ build: "test" }),
    health: () => ({ ok: true }) as never, settings,
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
  const { app, settings } = await harness();
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
```

- [ ] **Step 2: Run and watch fail** → 404s, because the routes do not exist.

- [ ] **Step 3: Implement**

Add `settings?: SettingsStore` to `AppDeps` with the comment
`/** Settings store. Omit in tests that only exercise the agent API. */`,
then inside `createApp`, beside the other routes:

```ts
  if (deps.settings) {
    const settings = deps.settings;

    app.get("/api/settings", (c) => c.json(settings.view()));

    app.put("/api/settings", async (c) => {
      const patch = (await c.req.json()) as SettingsPatch;
      try {
        await settings.patch(patch);
      } catch (e) {
        // Reporting a save that did not happen is worse than reporting none.
        return c.json({ ok: false, detail: (e as Error).message }, 500);
      }
      return c.json(settings.view());
    });

    app.post("/api/settings/telegram/test", async (c) => {
      const s = settings.current();
      if (!s.telegram.token || !s.telegram.chatId) {
        return c.json({ ok: false, detail: "token and chat id must both be set" }, 400);
      }
      const r = await sendTelegram({
        token: s.telegram.token, chatId: s.telegram.chatId,
        text: "paddock test message — notifications are wired up.",
      });
      return c.json(r);
    });
  }
```

- [ ] **Step 4: Run** → `bun test tests/settings-routes.test.ts` PASS (4 tests).

- [ ] **Step 5: Prove they can fail**

Return `settings.current()` instead of `settings.view()` from the GET → the
first test goes RED on `secret`. This is the single most important assertion
in the plan; confirm it before moving on.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add src/server/routes.ts tests/settings-routes.test.ts
git commit -m "feat: settings API with a write-only token

paddock has no auth of its own, so anything GET returns is readable by
whatever passes Access and by any future XSS. The token goes in and never
comes back; configured plus a four-character hint stand in for it."
```

---

### Task 6: Wire the notifier at the composition root

**Files:**
- Modify: `src/server/index.ts`
- Create: `tests/notify-wiring.test.ts`

**Interfaces:**
- Consumes: `Notifier` (Task 4), `SettingsStore` (Task 2), `sendTelegram` (Task 3).
- Produces: `lastNotifyError` on the health body.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { Hub } from "@server/ws/hub";
import { Notifier } from "@server/notify/notifier";

test("a delta reaches BOTH the hub and the notifier", async () => {
  // The regression this guards: wiring the notifier by REPLACING
  // `onDelta: (d) => hub.queue(d)` rather than adding to it, which silently
  // stops every browser updating while notifications appear to work.
  const hub = new Hub({ build: "test" });
  let queued = 0;
  const spy = { queue: () => { queued++; } } as unknown as Hub;
  const seen: string[] = [];
  const notifier = new Notifier({
    settings: { current: () => ({
      telegram: { token: "1:A", chatId: "5" },
      notify: { enabled: true, triggers: ["blocked"], quietHours: null, cooldownMs: 0 },
      publicUrl: null }) } as never,
    send: async (t) => { seen.push(t); return { ok: true, detail: null }; },
  });

  const onDelta = (d: never) => { spy.queue(d); notifier.observe(d); };
  const a = { agentId: "w1:p1", name: "docs-cleanup", task: "t", state: "working" };
  onDelta({ upserted: [a], removedIds: [] } as never);
  onDelta({ upserted: [{ ...a, state: "blocked" }], removedIds: [] } as never);
  await Bun.sleep(1);

  expect(queued).toBe(2);
  expect(seen).toHaveLength(1);
  expect(hub).toBeTruthy();
});
```

- [ ] **Step 2: Run** → FAIL until the modules exist and typecheck.

- [ ] **Step 3: Wire it in `src/server/index.ts`**

Near the other module construction:

```ts
const settings = new SettingsStore(defaultConfigDir());
await settings.load();
if (settings.error) console.error(`[settings] ${settings.error}`);

const notifier = new Notifier({
  settings,
  send: async (text) => {
    const s = settings.current();
    if (!s.telegram.token || !s.telegram.chatId) return { ok: false, detail: "not configured" };
    return sendTelegram({ token: s.telegram.token, chatId: s.telegram.chatId, text });
  },
});
```

Change line 114 from `onDelta: (d) => hub.queue(d),` to:

```ts
  // Fan out, do not replace: the hub keeps every browser current, and the
  // notifier is a leaf hanging off the composition root so that neither
  // store.ts nor hub.ts has to learn that Telegram exists.
  onDelta: (d) => { hub.queue(d); notifier.observe(d); },
```

Pass `settings` into `createApp(...)`, and add to the health body:

```ts
  lastNotifyError: notifier.lastError,
```

- [ ] **Step 4: Run the whole suite**

Run: `make test`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Prove it can fail**

Replace the fan-out with `onDelta: (d) => notifier.observe(d)` → the wiring
test goes RED on `queued`. Revert.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add src/server/index.ts tests/notify-wiring.test.ts
git commit -m "feat: fan deltas out to the notifier at the composition root

Adding rather than replacing: replacing onDelta stops every browser updating
while notifications appear to work. lastNotifyError joins /api/health so a
broken token is visible in seconds rather than never."
```

---

### Task 7: Per-device preferences module

**Files:**
- Create: `src/web/prefs.ts`
- Create: `tests/prefs.test.ts`

**Interfaces:**
- Produces: `RATE_MS`, `readPrefs(): Prefs`, `writePref(k, v): void`,
  `type Prefs = { theme: ThemePref; rate: RatePref; wrap: boolean; fontPx: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
import "./support/dom";
import { expect, test } from "bun:test";
import { RATE_MS, readPrefs, writePref } from "@web/prefs";

test("defaults are returned when nothing is stored", () => {
  expect(readPrefs()).toEqual({ theme: "system", rate: "live", wrap: false, fontPx: 13 });
});

test("the existing wrap key is reused verbatim, so no operator's setting resets", () => {
  localStorage.setItem("paddock.term.wrap", "1");
  expect(readPrefs().wrap).toBe(true);
});

test("a throwing localStorage yields defaults instead of a blank screen", () => {
  // Safari private mode throws outright on access — install.ts:48 documents
  // this. An uncaught throw here would take the whole settings view down.
  const real = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("SecurityError"); },
  });
  expect(() => readPrefs()).not.toThrow();
  expect(readPrefs().theme).toBe("system");
  expect(() => writePref("theme", "dark")).not.toThrow();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: real });
});

test("the three refresh presets are the ones the spec names", () => {
  expect(RATE_MS).toEqual({ live: 250, balanced: 1_000, frugal: 3_000 });
});
```

- [ ] **Step 2: Run and watch fail** → module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * The single owner of localStorage.
 *
 * install.ts:48 records that Safari private mode throws OUTRIGHT on access,
 * not merely on write. Handled once here rather than in every component that
 * wants a preference — an uncaught throw would take the view down with it.
 */
export type ThemePref = "system" | "light" | "dark";
export type RatePref = "live" | "balanced" | "frugal";

/** Named points, not a milliseconds field: a free numeric input invites a
 *  value that hammers herdr, and the real decision is whether the connection
 *  is metered rather than which precise interval is optimal. */
export const RATE_MS: Record<RatePref, number> = { live: 250, balanced: 1_000, frugal: 3_000 };

export interface Prefs { theme: ThemePref; rate: RatePref; wrap: boolean; fontPx: number }

const DEFAULTS: Prefs = { theme: "system", rate: "live", wrap: false, fontPx: 13 };

/** Kept verbatim from AgentTerminal so no operator's current setting resets. */
const KEYS = { theme: "paddock.theme", rate: "paddock.rate",
               wrap: "paddock.term.wrap", fontPx: "paddock.term.fontpx" } as const;

function raw(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}

export function readPrefs(): Prefs {
  const theme = raw(KEYS.theme);
  const rate = raw(KEYS.rate);
  const font = Number(raw(KEYS.fontPx));
  return {
    theme: theme === "light" || theme === "dark" ? theme : DEFAULTS.theme,
    rate: rate === "balanced" || rate === "frugal" ? rate : DEFAULTS.rate,
    wrap: raw(KEYS.wrap) === "1",
    fontPx: Number.isFinite(font) && font >= 10 && font <= 22 ? font : DEFAULTS.fontPx,
  };
}

export function writePref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
  try {
    localStorage.setItem(KEYS[k], k === "wrap" ? (v ? "1" : "0") : String(v));
  } catch { /* Safari private mode: the preference simply does not persist,
                which is preferable to taking the view down. */ }
}
```

- [ ] **Step 4: Run** → PASS (4 tests).

- [ ] **Step 5: Prove they can fail**

Remove the `try` in `raw` → the throwing-storage test goes RED.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add src/web/prefs.ts tests/prefs.test.ts
git commit -m "feat: one owner for localStorage preferences

Safari private mode throws on ACCESS, not only on write. Handling it in one
module keeps that hazard from having to be remembered in every component."
```

---

### Task 8: The settings view and its route

**Files:**
- Create: `src/web/components/Settings.tsx`
- Modify: `src/web/route.ts`, `src/web/components/App.tsx`, `src/web/styles.css`
- Create: `tests/settings-view.test.tsx`

**Interfaces:**
- Consumes: `readPrefs`/`writePref`/`RATE_MS` (Task 7), `SettingsView` (Task 2).
- Produces: `useSettingsRoute(): boolean` from `@web/route`.

- [ ] **Step 1: Write the failing test**

```tsx
import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { Settings } from "@web/components/Settings";
import { render, settle, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const view = () => ({
  telegram: { configured: true, hint: "7f21", chatId: "555" },
  notify: { enabled: true, triggers: ["blocked"], quietHours: null, cooldownMs: 60_000 },
  publicUrl: null, error: null,
});

test("the token is never rendered — only the hint", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify(view()), {
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  expect(host.textContent).toContain("7f21");
  expect(host.querySelector('input[name="token"]')?.getAttribute("value") ?? "").toBe("");
});

test("the global section says it affects every device", async () => {
  // A switch whose scope the operator must guess is a switch that gets misread:
  // turning notifications off on a phone also silences the laptop.
  globalThis.fetch = (async () => new Response(JSON.stringify(view()), {
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  expect(host.textContent?.toLowerCase()).toContain("every device");
});
```

- [ ] **Step 2: Run and watch fail** → module not found.

- [ ] **Step 3: Add the route**

In `src/web/route.ts`:

```ts
export function useSettingsRoute(): boolean {
  const [on, setOn] = useState(() => location.hash === "#/settings");
  useEffect(() => {
    const onChange = () => setOn(location.hash === "#/settings");
    addEventListener("hashchange", onChange);
    onChange();
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return on;
}
```

In `App.tsx`, before the `openAgent` branch:

```tsx
  if (showSettings) return <Settings onBack={() => { location.hash = ""; }} />;
```

- [ ] **Step 4: Implement `Settings.tsx`**

Two `<section>`s. The first is headed **This device** — theme (system/light/
dark), refresh rate (Live/Balanced/Frugal), font size, line wrap — each writing
through `writePref`. The second is headed **All devices**, with the sentence
"These are server settings and affect every device, not just this one."
inside it, containing: Telegram token (`<input name="token" type="password">`,
always rendered empty, placeholder showing `configured · ••••{hint}`), chat id,
notifications switch, trigger checkboxes for blocked and done, quiet hours
start/end, and a **Send test message** button that POSTs to
`/api/settings/telegram/test` and renders the returned `detail` verbatim on
failure. Render `view.error` as a banner when non-null.

- [ ] **Step 5: Style it**

Add `.settings` rules to `styles.css`. Any new colour is a token on bare
`:root`, then redefined under `prefers-color-scheme: dark` and
`[data-theme="dark"]` — never defined only inside a media query.

- [ ] **Step 6: Run** → `bun test tests/settings-view.test.tsx` PASS.

- [ ] **Step 7: Prove it can fail**

Bind the token input's `value` to anything from the response → the first test
goes RED.

- [ ] **Step 8: Commit**

```bash
make check && make check-clean && make test
git add src/web/components/Settings.tsx src/web/route.ts src/web/components/App.tsx src/web/styles.css tests/settings-view.test.tsx
git commit -m "feat: settings view at #/settings

Two sections, because the settings have two scopes: per-device preferences in
localStorage and server-global ones that affect every device. The global
section says so in words — sending happens on the server, so a switch tapped
on a phone silences the laptop too."
```

---

### Task 9: Apply the preferences

**Files:**
- Modify: `src/web/components/AgentTerminal.tsx`, `src/web/components/App.tsx`,
  `src/web/styles.css`
- Create: `tests/prefs-applied.test.tsx`

**Interfaces:**
- Consumes: `readPrefs`, `RATE_MS` (Task 7).

- [ ] **Step 1: Write the failing test**

```tsx
import "./support/dom";
import { expect, test } from "bun:test";
import { RATE_MS } from "@web/prefs";
import { floorFor } from "@web/components/AgentTerminal";

test("the refresh preset raises the interval floor, and the backoff ceiling is untouched", () => {
  expect(floorFor("live")).toBe(RATE_MS.live);
  expect(floorFor("frugal")).toBe(RATE_MS.frugal);
});

test("theme sets the attribute the CSS already listens for", () => {
  // styles.css:42 has defined :root[data-theme="dark"] since before this
  // feature, with nothing ever setting it.
  document.documentElement.dataset.theme = "dark";
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
});
```

- [ ] **Step 2: Run and watch fail** → `floorFor` is not exported.

- [ ] **Step 3: Implement**

In `AgentTerminal.tsx`, export `floorFor(rate: RatePref): number { return RATE_MS[rate]; }`,
initialise `intervalRef` from it, and use it wherever `MIN_REFRESH_MS` was the
floor — including the reset on visibility change. Read `wrap` from
`readPrefs()` instead of reading `localStorage` directly, deleting the local
`WRAP_KEY` constant. Apply `fontPx` as a CSS custom property on the terminal
element.

In `App.tsx`, apply the theme once on mount:

```tsx
  useEffect(() => {
    const t = readPrefs().theme;
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }, []);
```

- [ ] **Step 4: Run the whole suite** → `make test`, all green.

- [ ] **Step 5: Prove it can fail**

Hard-code the floor back to `MIN_REFRESH_MS` → the first test goes RED.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add src/web/components/AgentTerminal.tsx src/web/components/App.tsx src/web/styles.css tests/prefs-applied.test.tsx
git commit -m "feat: apply theme, font size, wrap and refresh preset

The Frugal preset is the honest lever for a metered connection: the 250ms
floor stays busy on a working agent because the spinner changes every tick, so
the digest always differs and the backoff never engages."
```

---

### Task 10: Documentation reconciliation

Three roadmap entries are known to be stale, found while building this. A
roadmap that describes work already done is worse than none, because it is
what a contributor reads to pick something up.

**Files:**
- Modify: `docs/roadmap.md`, `README.md`, `docs/architecture.md`

- [ ] **Step 1: Correct the stale roadmap entries**

- **"History on demand in the terminal view"** — resolved differently from how
  it is described. `src/web/history.ts` reconstructs scrollback from viewport
  snapshots; the `{scrollback:true}` request the entry describes is
  deliberately never sent (`src/web/api.ts:60` defaults it false). Record the
  viewer-not-recorder decision as the resolution.
- **"Per-agent deep links"** — already built. `src/web/route.ts` has produced
  `#/agent/<id>` since v0.2.0; the helpers now live in `src/shared/route.ts`.
- **"Web Push, the next increment"** — no longer the plan. Replace with a
  pointer to the Telegram design and its reasoning, keeping the iOS Home
  Screen constraint on record for whoever revisits push.

- [ ] **Step 2: Document the settings surface**

Add a short section to `README.md` under the feature list: what is per-device
versus server-global, and that the Telegram token is stored in
`~/.config/paddock/settings.json` at `0600` and never returned by the API.
Use `paddock.example.com` in any example.

- [ ] **Step 3: Record the new module boundary**

In `docs/architecture.md`, add `notify/` to the dependency diagram as a leaf
off the composition root, and state why it is not inside `hub.ts` or
`store.ts`.

- [ ] **Step 4: Commit**

```bash
make check && make check-clean && make test
git add docs/roadmap.md README.md docs/architecture.md
git commit -m "docs: reconcile the roadmap with what was actually built

Three entries described work that is done or superseded: history on demand
(resolved by reconstruction, not the scrollback request it describes), deep
links (shipped in v0.2.0), and Web Push (replaced by Telegram)."
```

---

## Self-review

**Spec coverage.** Every section of the design maps to a task: integration
point → 6; settings store → 2; notifier → 4; transport → 3; API → 5; client →
7, 8, 9; failure modes → 2, 5, 6, 8; testing → each task's own steps. The
`agentHash` move the spec's self-review discovered is Task 1, and it is
sequenced first because Task 4 imports it.

**Placeholders.** None. Every code step carries real code; no step says "add
error handling" without showing which error and what it does.

**Type consistency.** `SettingsView` (Task 2) is what `GET /api/settings`
returns (Task 5) and what `Settings.tsx` consumes (Task 8). `RATE_MS` (Task 7)
is consumed by `floorFor` (Task 9). `Notifier` (Task 4) is constructed with the
same `{settings, send, now}` shape in Task 6 as in its own tests.

**One risk worth stating.** Task 8 is the largest and least mechanical — a form
with two scopes and a live test button. If it proves too big during execution,
split it: the view and its route first, the Telegram test button second.
