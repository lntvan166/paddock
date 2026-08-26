# Notification Presence and Clearing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Withhold a push notification from the device already showing that agent's pane, deferring it until the viewer leaves, and clear notifications that no longer describe anything.

**Architecture:** A connection-keyed `PresenceStore` in `src/server/state/` is written by the WebSocket layer and read by the notifier through injected getters, so `ws/hub.ts` and `notify/` still never import each other. The notifier decides whether every subscribed device is viewing the agent *before* it stamps the cooldown, and holds the episode in a `#deferred` map that `reconsider()` re-arms when presence releases. Clearing is a client-side sweep over `registration.getNotifications()`; `public/sw.js` is not touched.

**Tech Stack:** Bun (test runner and server), TypeScript with path aliases (`@server/`, `@web/`, `@shared/`), React 19 with happy-dom for component tests, shadcn `Checkbox` in Settings, WebCrypto `crypto.subtle` on both sides.

**Spec:** `docs/design/2026-08-26-notification-presence-design.md` — read it before Task 1. It carries the reasoning; this plan carries the steps.

## Global Constraints

- **This repository is public.** No real hostnames, home paths, usernames, or employer terms in code, tests, comments or commit messages. Fixtures use invented agent names: `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`. Hosts are `dev-box` / `paddock.example.com`; paths are `/srv/project` or `/path/to/project`.
- **`make check-clean` before every commit.** If it fails, fix the content — never add the string to an ignore list.
- **`make test` (not bare `bun test`)** — it builds the UI first. `make check` is `tsc --noEmit`; there is no linter.
- **Dependency direction:** `herdr/socket → herdr/adapter → state/store → ws/hub → web/`. Nothing upstream imports downstream. `presence.ts` lives in `state/` because both `ws/serve.ts` and `notify/` use it; it imports neither.
- **Never swallow an error.** Capability detection (an API that does not exist in this browser) is not an error and returns silently; an actual rejection is logged.
- **No device detection, no `isMobile`, no user-agent parsing.** Presence is `document.visibilityState` plus the location hash.
- **A push payload carries `{ name, state, agentId }` and nothing else** — it renders on a lock screen. `skipDeviceKeys` is an argument to the sender, never a field in the JSON body.
- **New settings fields default to the current behaviour** until Task 8 flips them, so a half-wired presence store can never withhold a real notification.

---

## File Structure

**New**

| File | Responsibility |
| --- | --- |
| `src/server/state/presence.ts` | Connection-keyed presence, TTL expiry, change events |
| `src/shared/device-key.ts` | `hashEndpoint` — one algorithm, both sides |
| `src/web/device-key.ts` | This browser's device key, looked up once and cached |
| `src/web/notifications.ts` | `closeFor`, `sweep`, `useNotificationSweep` |
| `tests/presence.test.ts` | Presence unit tests |
| `tests/device-key.test.ts` | Hash shape and stability |
| `tests/ws-viewing.test.ts` | The frame parser, including hostile input |
| `tests/notifier-presence.test.ts` | Suppression, deferral, re-fire, mute interaction |
| `tests/notification-sweep.test.ts` | The sweep against a fake registration |

**Modified**

| File | Change |
| --- | --- |
| `src/shared/types.ts` | `ClientMessage`; `notify.skipWhileViewing` |
| `src/server/push/store.ts` | `StoredSubscription.deviceKey`, persisted and backfilled |
| `src/server/ws/serve.ts` | `parseClientMessage`, `message()`, presence on `close` |
| `src/server/notify/notifier.ts` | `viewers`/`pushDeviceKeys`, withhold-before-stamp, `#deferred`, `reconsider` |
| `src/server/index-wiring.ts` | `buildPushSender` skips matching device keys |
| `src/server/index.ts` | Construct and wire `PresenceStore`, dispose it |
| `src/server/tunnel/run.ts` | `presence` in the `hubWebSocket` deps |
| `src/server/settings/store.ts` | Default and migration for `skipWhileViewing` |
| `src/server/routes.ts` | PUT validator for `skipWhileViewing` |
| `src/web/store.ts` | `viewingMessage`, and send it on open / hash / visibility / heartbeat |
| `src/web/components/Settings.tsx` | State, dirty check, load, patch for the new field |
| `src/web/components/settings/NotifySection.tsx` | The checkbox and its copy |
| `src/web/components/App.tsx` | `useNotificationSweep(agents)` |

**One refinement of the spec, decided while reading the code.** The spec says the endpoint hash is computed at the composition root from `push.list()`. That would need either an async getter in `#fire` (an await between reading the cooldown and stamping it, which opens an interleaving window the current code does not have) or a hash cache with refresh discipline (forget a refresh and a new device is silently never suppressed). Persisting `deviceKey` in `push.json` at subscribe time, backfilled on load, makes the getter a synchronous read that is always current. Same join, computed once instead of per notification. Task 2 does this and Task 8 amends the spec to match.

---

### Task 1: The presence store

**Files:**
- Create: `src/server/state/presence.ts`
- Test: `tests/presence.test.ts`

**Interfaces:**
- Consumes: nothing. This task has no dependencies and no consumers yet.
- Produces: `class PresenceStore` with `set(client: object, e: { deviceKey: string | null; agentId: string | null }): void`, `drop(client: object): void`, `viewers(agentId: string): Set<string>`, `sweep(): void`, `onChange(cb: (agentId: string) => void): void`, `startSweep(): void`, `dispose(): void`. Constructor options `{ now?: () => number; staleMs?: number; sweepMs?: number }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/presence.test.ts`:

```ts
import { expect, test } from "bun:test";
import { PresenceStore } from "@server/state/presence";

const NOW = 1_700_000_000_000;

test("two connections on one device union rather than overwrite", () => {
  const p = new PresenceStore({ now: () => NOW });
  const pwa = {};
  const tab = {};
  p.set(pwa, { deviceKey: "dk-phone", agentId: "w1:p1" });
  // The same phone's Safari tab, sitting on the agent list. Keyed by device
  // key this would erase the PWA's view and suppression would flicker on
  // whichever surface spoke last.
  p.set(tab, { deviceKey: "dk-phone", agentId: null });
  expect([...p.viewers("w1:p1")]).toEqual(["dk-phone"]);
});

test("a viewer of one agent is not a viewer of another", () => {
  const p = new PresenceStore({ now: () => NOW });
  p.set({}, { deviceKey: "dk-phone", agentId: "w1:p1" });
  expect(p.viewers("w2:p1").size).toBe(0);
});

test("a client with no push subscription is recorded and views nothing", () => {
  // deviceKey null is a browser that never subscribed. It must not match a
  // target, and must not throw on the way to not matching one.
  const p = new PresenceStore({ now: () => NOW });
  p.set({}, { deviceKey: null, agentId: "w1:p1" });
  expect(p.viewers("w1:p1").size).toBe(0);
});

test("an entry older than the TTL is not a viewer", () => {
  // iOS suspends a backgrounded PWA without delivering visibilitychange, so
  // the socket can linger. Three missed heartbeats and it stops counting.
  let now = NOW;
  const p = new PresenceStore({ now: () => now, staleMs: 60_000 });
  p.set({}, { deviceKey: "dk-phone", agentId: "w1:p1" });
  now = NOW + 60_001;
  expect(p.viewers("w1:p1").size).toBe(0);
});

test("the sweep drops an expired entry and announces its agent", () => {
  let now = NOW;
  const seen: string[] = [];
  const p = new PresenceStore({ now: () => now, staleMs: 60_000 });
  p.onChange((agentId) => seen.push(agentId));
  p.set({}, { deviceKey: "dk-phone", agentId: "w1:p1" });
  now = NOW + 60_001;
  p.sweep();
  expect(seen).toEqual(["w1:p1"]);
  // Dropped, not merely ignored: the map must not grow for every socket that
  // ever connected.
  p.sweep();
  expect(seen).toEqual(["w1:p1"]);
});

test("dropping a client announces the agent it was viewing", () => {
  const seen: string[] = [];
  const p = new PresenceStore({ now: () => NOW });
  p.onChange((agentId) => seen.push(agentId));
  const c = {};
  p.set(c, { deviceKey: "dk-phone", agentId: "w1:p1" });
  p.drop(c);
  expect(seen).toEqual(["w1:p1"]);
  expect(p.viewers("w1:p1").size).toBe(0);
});

test("moving to another agent announces the one left behind", () => {
  const seen: string[] = [];
  const p = new PresenceStore({ now: () => NOW });
  p.onChange((agentId) => seen.push(agentId));
  const c = {};
  p.set(c, { deviceKey: "dk-phone", agentId: "w1:p1" });
  p.set(c, { deviceKey: "dk-phone", agentId: "w2:p1" });
  expect(seen).toEqual(["w1:p1"]);
});

test("dropping a client that was viewing nothing announces nothing", () => {
  const seen: string[] = [];
  const p = new PresenceStore({ now: () => NOW });
  p.onChange((agentId) => seen.push(agentId));
  const c = {};
  p.set(c, { deviceKey: "dk-phone", agentId: null });
  p.drop(c);
  expect(seen).toEqual([]);
});

test("a throwing listener does not stop the others, and does not escape", () => {
  // A presence change runs on the socket's close path. An exception there
  // would take down a connection teardown to deliver a notification hint.
  const seen: string[] = [];
  const p = new PresenceStore({ now: () => NOW });
  p.onChange(() => { throw new Error("listener exploded"); });
  p.onChange((agentId) => seen.push(agentId));
  const c = {};
  p.set(c, { deviceKey: "dk-phone", agentId: "w1:p1" });
  expect(() => p.drop(c)).not.toThrow();
  expect(seen).toEqual(["w1:p1"]);
});

test("dispose clears the entries and the listeners", () => {
  const p = new PresenceStore({ now: () => NOW });
  p.set({}, { deviceKey: "dk-phone", agentId: "w1:p1" });
  p.dispose();
  expect(p.viewers("w1:p1").size).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/presence.test.ts`
Expected: FAIL — `Cannot find module '@server/state/presence'`.

- [ ] **Step 3: Write the implementation**

Create `src/server/state/presence.ts`:

```ts
/**
 * Who is looking at what, right now.
 *
 * In `state/` because both `ws/serve.ts` (which writes it) and `notify/`
 * (which reads it) need it, and neither may import the other —
 * `docs/architecture.md` fixes that direction. This module imports nothing
 * from either, and nothing about herdr or about transport.
 *
 * Its only consumer semantics: `viewers(agentId)` answers "which DEVICES have
 * this agent's pane open and awake". A push that would land on one of those
 * devices is telling it something it is already showing.
 */

export interface PresenceEntry {
  /** `base64url(SHA-256(endpoint))`, or null for a browser with no
   *  subscription — recorded, but never a viewer, because there is no push
   *  target it could suppress. */
  deviceKey: string | null;
  agentId: string | null;
  at: number;
}

/** Three missed 20s heartbeats. See `#staleMs` below. */
const DEFAULT_STALE_MS = 60_000;

export class PresenceStore {
  /**
   * Keyed by the CONNECTION, never by the device key.
   *
   * A Safari tab and the installed PWA on one phone share a device key and
   * have separate sockets and separate location hashes. Keyed by device key,
   * whichever spoke last would overwrite the other: the tab on the agent list
   * would erase the PWA's "viewing api-refactor" and suppression would
   * flicker on which surface moved most recently. So each connection holds its
   * own entry and `viewers` unions them — a device is viewing an agent if ANY
   * of its connections is.
   */
  #entries = new Map<object, PresenceEntry>();
  #listeners: ((agentId: string) => void)[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #now: () => number;
  /**
   * How long an entry counts without being refreshed.
   *
   * The client re-sends its frame once per heartbeat it receives, so the reply
   * IS the liveness proof and no new timer exists on either side. Three missed
   * heartbeats is the allowance. This covers the case the socket's own `close`
   * cannot: iOS suspending a backgrounded PWA delivers no `visibilitychange`
   * and may leave the socket hanging, and a stale entry would suppress
   * notifications for a phone asleep in a pocket.
   */
  readonly #staleMs: number;
  readonly #sweepMs: number;

  constructor(o: { now?: () => number; staleMs?: number; sweepMs?: number } = {}) {
    this.#now = o.now ?? Date.now;
    this.#staleMs = o.staleMs ?? DEFAULT_STALE_MS;
    this.#sweepMs = o.sweepMs ?? 20_000;
  }

  set(client: object, e: { deviceKey: string | null; agentId: string | null }): void {
    const prev = this.#entries.get(client);
    this.#entries.set(client, { deviceKey: e.deviceKey, agentId: e.agentId, at: this.#now() });
    // The agent this client LEFT may now have no viewers at all, which is the
    // event a deferred notification is waiting for. The agent it arrived at
    // needs no announcement: gaining a viewer never releases anything.
    if (prev !== undefined && prev.agentId !== null && prev.agentId !== e.agentId) {
      this.#emit(prev.agentId);
    }
  }

  drop(client: object): void {
    const prev = this.#entries.get(client);
    if (prev === undefined) return;
    this.#entries.delete(client);
    if (prev.agentId !== null) this.#emit(prev.agentId);
  }

  viewers(agentId: string): Set<string> {
    const cutoff = this.#now() - this.#staleMs;
    const out = new Set<string>();
    for (const e of this.#entries.values()) {
      if (e.agentId !== agentId) continue;
      if (e.at < cutoff) continue;
      if (e.deviceKey !== null) out.add(e.deviceKey);
    }
    return out;
  }

  /**
   * Drop expired entries, announcing each agent that may have lost a viewer.
   *
   * PUBLIC so tests drive expiry on an injected clock without waiting out a
   * real interval, and so expiry is an EVENT like every other release rather
   * than a condition someone has to poll for.
   */
  sweep(): void {
    const cutoff = this.#now() - this.#staleMs;
    for (const [client, e] of [...this.#entries]) {
      if (e.at >= cutoff) continue;
      this.#entries.delete(client);
      if (e.agentId !== null) this.#emit(e.agentId);
    }
  }

  onChange(cb: (agentId: string) => void): void {
    this.#listeners.push(cb);
  }

  startSweep(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.sweep(), this.#sweepMs);
    // A presence sweep must never be the reason the process stays alive —
    // the same rule the notifier's settle timers follow.
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#entries.clear();
    this.#listeners.length = 0;
  }

  /**
   * Reported, never rethrown. A change fires from a socket's `close` handler
   * and from a timer: an exception escaping here would take down a connection
   * teardown, or the process, to deliver a hint about a notification.
   */
  #emit(agentId: string): void {
    for (const cb of this.#listeners) {
      try {
        cb(agentId);
      } catch (e) {
        console.info(`paddock: presence listener failed: ${(e as Error).message}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/presence.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck, scan, commit**

```bash
make check && make check-clean
git add src/server/state/presence.ts tests/presence.test.ts
git commit -m "feat: a presence store, keyed by connection rather than by device"
```

---

### Task 2: The device key, persisted where it is used

**Files:**
- Create: `src/shared/device-key.ts`, `tests/device-key.test.ts`
- Modify: `src/server/push/store.ts`
- Test: `tests/device-key.test.ts`, `tests/push-store.test.ts` (append)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `hashEndpoint(endpoint: string): Promise<string>` from `@shared/device-key`; `StoredSubscription.deviceKey: string`; `PushStore.deviceKeys(): Set<string>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/device-key.test.ts`:

```ts
import { expect, test } from "bun:test";
import { hashEndpoint } from "@shared/device-key";

const ENDPOINT = "https://push.example.com/send/abc123";

test("the key is unpadded base64url", async () => {
  // It travels in a JSON frame and is compared as a string. base64url is what
  // every other key in this codebase uses (VAPID, p256dh, auth), and a second
  // encoding is a second thing to get wrong.
  expect(await hashEndpoint(ENDPOINT)).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("the same endpoint always hashes the same, and a different one differs", async () => {
  // Stability is the whole contract: the browser hashes its endpoint, the
  // server hashes the stored copy of the same endpoint, and the two must meet.
  expect(await hashEndpoint(ENDPOINT)).toBe(await hashEndpoint(ENDPOINT));
  expect(await hashEndpoint(ENDPOINT)).not.toBe(await hashEndpoint(`${ENDPOINT}x`));
});

test("the key does not contain the endpoint", async () => {
  // An endpoint is a bearer credential for pushing to that device. The hash
  // exists so the credential is not the thing on the wire.
  const k = await hashEndpoint(ENDPOINT);
  expect(k).not.toContain("push.example.com");
  expect(k).not.toContain("abc123");
});
```

Append to `tests/push-store.test.ts` (add any of `mkdtemp`, `writeFile`, `tmpdir`, `join` and `hashEndpoint` that its imports are missing):

```ts
test("a subscription is stored with its device key, and an old file is backfilled", async () => {
  // The key is persisted rather than derived per notification so the
  // notifier's roster getter can be synchronous: an await between reading the
  // cooldown and stamping it would open an interleaving window `#fire` does
  // not have today.
  const d = await mkdtemp(join(tmpdir(), "paddock-push-"));
  await writeFile(join(d, "push.json"), JSON.stringify({
    keys: { publicKey: "BP4z", privateKey: { kty: "EC", crv: "P-256", d: "x" } },
    subscriptions: [{ endpoint: "https://push.example.com/send/legacy", p256dh: "p", auth: "a" }],
  }));
  const s = await PushStore.load(d);
  const stored = s.list()[0]!;
  expect(stored.deviceKey).toBe(await hashEndpoint("https://push.example.com/send/legacy"));
  expect(s.deviceKeys()).toEqual(new Set([stored.deviceKey]));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/device-key.test.ts tests/push-store.test.ts`
Expected: FAIL — `Cannot find module '@shared/device-key'`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/device-key.ts`:

```ts
/**
 * One device's identity for suppression, derived from its push endpoint.
 *
 * In `shared/` because BOTH sides compute it and the two results must be equal
 * for the feature to work at all: the browser hashes the endpoint it holds,
 * the server hashes the copy it stored, and a second implementation is a
 * second thing to drift. `quick-tunnel.ts` is the precedent for a shared pure
 * function living beside the shared types.
 *
 * A HASH rather than the endpoint itself. An endpoint is a bearer credential
 * for pushing to that device: it is already stored once, in `push.json`, and
 * there is no reason to put it on a second wire or to create a second value
 * that must never reach a log line. `index-wiring.ts` already logs only an
 * endpoint's origin for the same reason.
 *
 * `crypto.subtle` needs a secure context, which the service worker that
 * produced the subscription already required — so this adds no constraint that
 * push did not already impose.
 */
export async function hashEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return b64url(new Uint8Array(digest));
}

/** Unpadded base64url, matching every other key in this codebase. */
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```

In `src/server/push/store.ts`, extend the stored shape:

```ts
export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  /**
   * `hashEndpoint(endpoint)`, persisted rather than recomputed.
   *
   * The notifier needs the roster of device keys SYNCHRONOUSLY, above the
   * cooldown stamp in `#fire` — hashing there would mean an await between
   * reading `since` and writing `#lastSentAt`, which is an interleaving window
   * that code does not have today. Written once where the endpoint arrives,
   * and backfilled on load for a file written before this existed.
   */
  deviceKey: string;
}
```

Add `import { hashEndpoint } from "@shared/device-key";`, backfill in `load()` after the subscriptions are parsed:

```ts
    // A file written before device keys existed has none. Backfilled rather
    // than left absent: an unkeyed subscription can never be suppressed, so it
    // would silently keep buzzing the phone that is showing the agent.
    const subs = await Promise.all(
      parsedSubs.map(async (s) => ({
        ...s, deviceKey: s.deviceKey ?? await hashEndpoint(s.endpoint),
      })),
    );
```

fill it in whichever method adds a subscription (`add` / `upsert` in this file):

```ts
    const deviceKey = await hashEndpoint(sub.endpoint);
```

and add the roster getter beside `list()`:

```ts
  /** Every subscribed device's key. The notifier's roster — see its `#fire`. */
  deviceKeys(): Set<string> {
    return new Set(this.#subs.map((s) => s.deviceKey));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/device-key.test.ts tests/push-store.test.ts tests/push-store-paths.test.ts tests/push-routes.test.ts`
Expected: PASS. `push-routes` is included because the subscribe route builds a `StoredSubscription`; if it constructs the object literally, `make check` names the line.

- [ ] **Step 5: Typecheck, scan, commit**

```bash
make check && make check-clean
git add src/shared/device-key.ts src/server/push/store.ts tests/device-key.test.ts tests/push-store.test.ts
git commit -m "feat: persist a device key per subscription, backfilling old files"
```

---

### Task 3: The `viewing` frame

**Files:**
- Modify: `src/shared/types.ts`, `src/server/ws/serve.ts`, `src/server/tunnel/run.ts`, `src/web/store.ts`
- Create: `src/web/device-key.ts`, `tests/ws-viewing.test.ts`
- Test: `tests/ws-viewing.test.ts`, `tests/web-store.test.ts` (append)

**Interfaces:**
- Consumes: `PresenceStore` (Task 1), `hashEndpoint` (Task 2).
- Produces: `ClientMessage` from `@shared/types`; `parseClientMessage(raw: unknown): ClientMessage | null` and `MAX_CLIENT_FRAME` from `@server/ws/serve`; `viewingMessage(o: { deviceKey: string | null; hash: string; hidden: boolean }): ClientMessage` from `@web/store`; `deviceKey(): Promise<string | null>` and `resetDeviceKey(): void` from `@web/device-key`. `HubSocketDeps` gains `presence: PresenceStore`.

- [ ] **Step 1: Write the failing tests**

Create `tests/ws-viewing.test.ts`:

```ts
import { expect, test } from "bun:test";
import { MAX_CLIENT_FRAME, parseClientMessage } from "@server/ws/serve";

test("a valid frame parses", () => {
  expect(parseClientMessage(JSON.stringify({ type: "viewing", deviceKey: "dk", agentId: "w1:p1" })))
    .toEqual({ type: "viewing", deviceKey: "dk", agentId: "w1:p1" });
});

test("nulls are meaningful and preserved", () => {
  // deviceKey null: a browser with no subscription. agentId null: on the list,
  // or hidden. Both are statements, not absences.
  expect(parseClientMessage(JSON.stringify({ type: "viewing", deviceKey: null, agentId: null })))
    .toEqual({ type: "viewing", deviceKey: null, agentId: null });
});

test("junk returns null instead of throwing", () => {
  // This is the first untrusted input this socket has ever accepted. Throwing
  // in a Bun `message` handler drops the connection, which would make a
  // malformed frame a way to disconnect somebody's dashboard.
  for (const raw of ["", "{", "null", "[]", '"a string"', "42"]) {
    expect(parseClientMessage(raw)).toBeNull();
  }
});

test("an unknown type is ignored, not rejected loudly", () => {
  // A newer client talking to an older server degrades to no presence rather
  // than to a broken socket.
  expect(parseClientMessage(JSON.stringify({ type: "typing", agentId: "w1:p1" }))).toBeNull();
});

test("wrong field types are refused", () => {
  expect(parseClientMessage(JSON.stringify({ type: "viewing", deviceKey: 7, agentId: "w1:p1" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ type: "viewing", deviceKey: "dk", agentId: {} }))).toBeNull();
});

test("an oversized frame is refused before it is parsed", () => {
  const huge = JSON.stringify({ type: "viewing", deviceKey: "d".repeat(MAX_CLIENT_FRAME), agentId: null });
  expect(parseClientMessage(huge)).toBeNull();
});

test("a plausible frame with an implausibly long id is refused", () => {
  // A pane id is `w1:p1`. Nothing paddock issues is 300 characters, and the
  // value becomes a Map key held until the socket closes.
  expect(parseClientMessage(JSON.stringify({
    type: "viewing", deviceKey: "dk", agentId: "w".repeat(300),
  }))).toBeNull();
});

test("a non-string input is refused", () => {
  expect(parseClientMessage(undefined)).toBeNull();
  expect(parseClientMessage({ type: "viewing" })).toBeNull();
});
```

Append to `tests/web-store.test.ts`, adding `viewingMessage` to its existing `@web/store` import:

```ts
test("the viewing frame carries the pane in the hash", () => {
  expect(viewingMessage({ deviceKey: "dk", hash: "#/pane/w1%3Ap1", hidden: false }))
    .toEqual({ type: "viewing", deviceKey: "dk", agentId: "w1:p1" });
});

test("a hidden page is viewing nothing, whatever its hash says", () => {
  // Presence means "this device is SHOWING the agent". A backgrounded PWA with
  // a pane in its hash is showing nothing, and treating it as a viewer is how
  // a pocketed phone stays silent about an agent that is waiting.
  expect(viewingMessage({ deviceKey: "dk", hash: "#/pane/w1%3Ap1", hidden: true }))
    .toEqual({ type: "viewing", deviceKey: "dk", agentId: null });
});

test("the agent list is viewing nothing", () => {
  // Suppression is per agent, not per app: being in paddock somewhere else
  // must never silence anything.
  expect(viewingMessage({ deviceKey: "dk", hash: "#/settings", hidden: false }))
    .toEqual({ type: "viewing", deviceKey: "dk", agentId: null });
});

test("the legacy #/agent/ deep link counts as viewing", () => {
  // Every Telegram message ever sent used that form and they are still in chat
  // histories, so it still parses — including here.
  expect(viewingMessage({ deviceKey: null, hash: "#/agent/w1%3Ap1", hidden: false }))
    .toEqual({ type: "viewing", deviceKey: null, agentId: "w1:p1" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/ws-viewing.test.ts tests/web-store.test.ts`
Expected: FAIL — neither `parseClientMessage` nor `viewingMessage` is exported.

- [ ] **Step 3: Write the implementation**

In `src/shared/types.ts`, beside `ServerMessage`:

```ts
/**
 * The ONLY thing a browser may say on this socket, and the first thing it has
 * ever been allowed to say.
 *
 * `viewing` is presence: which device this is, and which pane it is SHOWING
 * (null for the list, for Settings, and for a page that is hidden). The server
 * uses it to withhold a push from a device already displaying the agent the
 * push is about.
 *
 * It deliberately cannot ask for anything. Every state change still goes
 * through a POST route, where `docs/decisions.md` put them — a socket that can
 * mutate is a socket whose every frame needs the origin and body validation
 * those routes already have.
 */
export type ClientMessage =
  | { type: "viewing"; deviceKey: string | null; agentId: string | null };
```

In `src/server/ws/serve.ts`:

```ts
import type { PresenceStore } from "@server/state/presence";
import type { ClientMessage } from "@shared/types";

export interface HubSocketDeps {
  hub: Hub;
  hostId: string;
  store: AgentStore;
  presence: PresenceStore;
}

/**
 * The frame cap. A `viewing` frame is about 120 bytes; 1 KB is generous and
 * finite, which is the property that matters for something a client controls.
 */
export const MAX_CLIENT_FRAME = 1024;

/** Longest plausible values. A pane id is `w1:p1`; a device key is 43 chars. */
const MAX_DEVICE_KEY = 128;
const MAX_AGENT_ID = 256;

/**
 * A client frame, or null for anything paddock does not recognise.
 *
 * NULL RATHER THAN A THROW, at every branch. Throwing inside Bun's `message`
 * handler drops the connection, which would turn a malformed frame into a way
 * to disconnect somebody's dashboard — and an unknown `type` is what a newer
 * client talking to an older server looks like, which must degrade to no
 * presence rather than to a broken socket.
 *
 * Exported so the parser is tested directly against hostile input rather than
 * only through a live socket.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_CLIENT_FRAME) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (m.type !== "viewing") return null;
  const { deviceKey, agentId } = m;
  if (deviceKey !== null && typeof deviceKey !== "string") return null;
  if (agentId !== null && typeof agentId !== "string") return null;
  if (deviceKey !== null && deviceKey.length > MAX_DEVICE_KEY) return null;
  if (agentId !== null && agentId.length > MAX_AGENT_ID) return null;
  return { type: "viewing", deviceKey, agentId };
}
```

and give the handlers their new job:

```ts
    close(ws) {
      const held = ws.data.client;
      if (held) {
        deps.hub.remove(held);
        // Presence dies with the connection. This is the fast path of the three
        // that release a viewer; the TTL in `presence.ts` covers the socket iOS
        // never closes.
        deps.presence.drop(held);
      }
    },
    message(ws, raw) {
      const client = ws.data.client;
      if (client === undefined) return;
      // Sized BEFORE any conversion: measuring a Buffer by `byteLength` rather
      // than stringifying it first is what keeps the cap a cap.
      const size = typeof raw === "string" ? raw.length : raw.byteLength;
      if (size > MAX_CLIENT_FRAME) return;
      const msg = parseClientMessage(typeof raw === "string" ? raw : raw.toString());
      if (msg === null) return;
      // The agentId is a Map key, compared against ids the store already holds.
      // It never reaches herdr, so there is nothing behind it to reach.
      deps.presence.set(client, { deviceKey: msg.deviceKey, agentId: msg.agentId });
    },
```

In `src/server/tunnel/run.ts`, add `presence?: PresenceStore` to the deps interface beside `hub?: Hub` — with a comment noting that an ATTACHED tunnel has none, because it has no hub, store or notifier either — and pass it through:

```ts
      websocket: hubWebSocket({
        hub: deps.hub!, hostId: deps.hostId!, store: deps.store!, presence: deps.presence!,
      }),
```

Create `src/web/device-key.ts`:

```ts
import { hashEndpoint } from "@shared/device-key";

/**
 * This browser's device key, or null when it has no push subscription.
 *
 * Cached for the life of the page: a subscription's endpoint does not change
 * while the tab is open, and this is read on every heartbeat.
 *
 * Here rather than in `store.ts` so the store keeps knowing nothing about push
 * — it awaits an opaque string and sends it.
 */
let cached: string | null | undefined;

export async function deviceKey(): Promise<string | null> {
  if (cached !== undefined) return cached;
  cached = await compute();
  return cached;
}

async function compute(): Promise<string | null> {
  const sw = globalThis.navigator?.serviceWorker;
  // Not an error: a browser without a service worker has no subscription to
  // identify, and a page with no subscription suppresses nothing.
  if (sw === undefined) return null;
  try {
    const reg = await sw.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub === null || sub === undefined ? null : await hashEndpoint(sub.endpoint);
  } catch (e) {
    console.info(`paddock: could not read the push subscription: ${(e as Error).message}`);
    return null;
  }
}

/** Forget what was cached — the unsubscribe path, and a test seam. */
export function resetDeviceKey(): void {
  cached = undefined;
}
```

In `src/web/store.ts`, add the pure frame builder:

```ts
/**
 * What this device is showing, as a frame.
 *
 * Pure and exported so the RULE is tested — the socket wiring around it is
 * not, exactly as `wsUrlFrom` is tested and `open()` is not.
 *
 * `hidden` collapses the hash to null. Presence means "this device is SHOWING
 * the agent": a backgrounded PWA with a pane in its hash shows nothing, and
 * treating it as a viewer is how a pocketed phone stays silent about an agent
 * that is waiting for it.
 */
export function viewingMessage(o: {
  deviceKey: string | null; hash: string; hidden: boolean;
}): ClientMessage {
  return {
    type: "viewing",
    deviceKey: o.deviceKey,
    agentId: o.hidden ? null : agentIdFromHash(o.hash),
  };
}
```

and inside the store factory, beside `open`:

```ts
  /** Resolved once, then reused: see `@web/device-key`. */
  let key: string | null = null;

  const sendViewing = () => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(viewingMessage({
      deviceKey: key,
      hash: globalThis.location?.hash ?? "",
      hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
    })));
  };
```

Wire it in four places, all of them cheap:

- in `ws.onopen`, after `set({ connected: true })`: `void deviceKey().then((k) => { key = k; sendViewing(); });`
- in `ws.onmessage`, after `set(applyMessage(...))`: `if (msg.type === "heartbeat") sendViewing();` — the reply to the hub's existing 20s heartbeat IS the keep-alive, so presence needs no timer of its own on either side.
- in the existing `visibilitychange` listener, after the reconnect branch: `sendViewing();`
- a new listener beside it: `addEventListener("hashchange", sendViewing);`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/ws-viewing.test.ts tests/web-store.test.ts tests/tunnel-run.test.ts tests/hub.test.ts`
Expected: PASS. The tunnel and hub suites are included because `HubSocketDeps` gained a required field.

- [ ] **Step 5: Typecheck, scan, commit**

```bash
make check && make check-clean
git add src/shared/types.ts src/server/ws/serve.ts src/server/tunnel/run.ts src/web/store.ts src/web/device-key.ts tests/ws-viewing.test.ts tests/web-store.test.ts
git commit -m "feat: a viewing frame, and the first client message this socket accepts"
```

Presence is now populated and read by nobody. Nothing behaves differently, which is the point of stopping here.

---

### Task 4: Withholding a push from the device that is showing it

**Files:**
- Modify: `src/server/notify/notifier.ts`, `src/server/index-wiring.ts`
- Test: `tests/notifier-presence.test.ts` (create), `tests/notify-wiring.test.ts` (append)

**Interfaces:**
- Consumes: `PresenceStore.viewers` (Task 1), `PushStore.deviceKeys` and `StoredSubscription.deviceKey` (Task 2).
- Produces: `NotifierOpts.viewers?: (agentId: string) => Set<string>`, `NotifierOpts.pushDeviceKeys?: () => Set<string>`, and `NotifierOpts.sendPush`'s payload extended with `skipDeviceKeys: Set<string>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/notifier-presence.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Notifier } from "@server/notify/notifier";
import type { Agent, AgentState, InlineKeyboard } from "@shared/types";

const NOW = 1_700_000_000_000;
const PHONE = "dk-phone";
const TABLET = "dk-tablet";

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "flaky-test-fix",
  task: "Quarantine the retry test", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", harness: "claude",
  stateSince: NOW, stateSinceExact: true,
  updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
});

type PushPayload = { name: string; state: AgentState; agentId: string; skipDeviceKeys: Set<string> };

/** Mirrors `tests/notifier-push.test.ts`'s harness, plus presence. */
function buildNotifier(o: {
  send?: (text: string, m?: InlineKeyboard) => Promise<{ ok: boolean; detail: string | null }>;
  sendPush?: (p: PushPayload) => Promise<void>;
  viewers?: (agentId: string) => Set<string>;
  pushDeviceKeys?: () => Set<string>;
  telegram?: { token: string; chatId: string };
  skipWhileViewing?: boolean;
  cooldownMs?: number;
}) {
  const store = {
    current: () => ({
      // No Telegram by default here: presence governs push, and a configured
      // Telegram would deliver every one of these and mask the behaviour.
      telegram: o.telegram ?? { token: "", chatId: "" },
      notify: {
        telegram: true, triggers: ["blocked"],
        settleMs: { blocked: 0, done: 0 }, mutedUntil: null,
        cooldownMs: o.cooldownMs ?? 60_000,
        skipWhileViewing: o.skipWhileViewing ?? true,
      },
      push: { enabled: true },
      publicUrl: "https://paddock.example.com",
    }),
  };
  return new Notifier({
    settings: store as never,
    send: o.send ?? (async () => ({ ok: true, detail: null })),
    sendPush: o.sendPush,
    viewers: o.viewers,
    pushDeviceKeys: o.pushDeviceKeys,
    now: () => NOW,
  });
}

async function settleBlocked(n: Notifier, over: Partial<Agent> = {}) {
  n.observe({ upserted: [agent({ ...over, state: "working" })], removedIds: [] });
  n.observe({ upserted: [agent({ ...over, state: "blocked" })], removedIds: [] });
  await Bun.sleep(5);
}

test("no push is sent when the only device is showing that agent", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  // Not "sent and then dropped by the transport" — nothing is dispatched at
  // all, which is also what leaves the cooldown unspent.
  expect(push).toEqual([]);
});

test("a viewer of a DIFFERENT agent suppresses nothing", async () => {
  // Suppression is per agent, not per app. Reading docs-cleanup must never
  // silence flaky-test-fix.
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: (id) => (id === "w9:p9" ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});

test("a second device that is not looking is still told", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE, TABLET]),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
  // The phone is named to the transport, which skips it. Partial suppression
  // sends: you were told, on a device that was not already showing you.
  expect([...push[0]!.skipDeviceKeys]).toEqual([PHONE]);
});

test("with nothing subscribed, a viewer suppresses nothing", async () => {
  // An empty roster is not suppression, and deferring would wait for a
  // departure that can never happen.
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set(),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});

test("Telegram still delivers while push is withheld", async () => {
  // A device key identifies one browser. A Telegram chat can be read from a
  // laptop, so presence can make no claim about it.
  const telegram: string[] = [];
  const push: PushPayload[] = [];
  const n = buildNotifier({
    telegram: { token: "1:A", chatId: "555" },
    send: async (t) => { telegram.push(t); return { ok: true, detail: null }; },
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  expect(telegram).toHaveLength(1);
  expect(push).toEqual([]);
});

test("the toggle off restores today's behaviour exactly", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    skipWhileViewing: false,
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
  expect([...push[0]!.skipDeviceKeys]).toEqual([]);
});

test("a notifier with no presence getters behaves as it does today", async () => {
  // The demo server and an attached tunnel construct a notifier without
  // presence. Absent getters must mean "no suppression", never "suppress
  // everything".
  const push: PushPayload[] = [];
  const n = buildNotifier({ sendPush: async (p) => { push.push(p); } });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});
```

Append to `tests/notify-wiring.test.ts`:

```ts
test("the push sender skips the devices named in skipDeviceKeys", async () => {
  const PHONE_ENDPOINT = "https://push.example.com/phone";
  const TABLET_ENDPOINT = "https://push.example.com/tablet";
  const store = {
    keys: () => FAKE_KEYS,
    list: () => [
      { endpoint: PHONE_ENDPOINT, p256dh: P256DH, auth: AUTH, deviceKey: "dk-phone" },
      { endpoint: TABLET_ENDPOINT, p256dh: P256DH, auth: AUTH, deviceKey: "dk-tablet" },
    ],
    remove: async () => {},
  };
  const sent: string[] = [];
  const send = buildPushSender(store as never, async (target) => {
    sent.push(target.endpoint);
    return { kind: "ok" };
  });
  await send!({
    name: "docs-cleanup", state: "blocked", agentId: "w1:p1",
    skipDeviceKeys: new Set(["dk-phone"]),
  });
  expect(sent).toEqual([TABLET_ENDPOINT]);
});

test("the skip set never reaches the payload", async () => {
  // A push payload is `{name, state, agentId}` and nothing else — it renders
  // on a lock screen, and `skipDeviceKeys` is an argument, not content.
  const store = {
    keys: () => FAKE_KEYS,
    list: () => [{ endpoint: "https://push.example.com/x", p256dh: P256DH, auth: AUTH, deviceKey: "dk-x" }],
    remove: async () => {},
  };
  const bodies: string[] = [];
  const send = buildPushSender(store as never, async (_t, _k, payload) => {
    bodies.push(payload);
    return { kind: "ok" };
  });
  await send!({
    name: "docs-cleanup", state: "blocked", agentId: "w1:p1", skipDeviceKeys: new Set(["dk-other"]),
  });
  expect(JSON.parse(bodies[0]!)).toEqual({ name: "docs-cleanup", state: "blocked", agentId: "w1:p1" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/notifier-presence.test.ts tests/notify-wiring.test.ts`
Expected: FAIL — `viewers` is not a `NotifierOpts` field, and the withheld cases send a push.

- [ ] **Step 3: Write the implementation**

In `src/server/index-wiring.ts`, take the skip set and drop it before the body is built:

```ts
export function buildPushSender(
  store: Pick<PushStore, "keys" | "list" | "remove">,
  send: (target: PushTarget, keys: VapidKeys, payload: string) => Promise<PushOutcome>,
): ((p: {
  name: string; state: AgentState; agentId: string; skipDeviceKeys: Set<string>;
}) => Promise<void>) | null {
  const keys = store.keys();
  if (keys === null) return null;
  return async (payload) => {
    // Destructured OFF, not merely unused: `content` is what gets encrypted,
    // and a push payload is `{name, state, agentId}` and nothing else because
    // it renders on a lock screen.
    const { skipDeviceKeys, ...content } = payload;
    const body = JSON.stringify(content);
    for (const target of store.list()) {
      // Already showing this agent on that device. Withheld here rather than
      // filtered upstream so the notifier states the policy and the transport
      // applies it — `notifier.ts` owns every decision, this file owns none.
      if (skipDeviceKeys.has(target.deviceKey)) continue;
      const out = await send(target, keys, body);
      // ... existing prune-on-gone and log-on-failed branches, unchanged
    }
  };
}
```

In `src/server/notify/notifier.ts`, extend `NotifierOpts`:

```ts
  /**
   * Which DEVICES have this agent's pane open and awake, from
   * `state/presence.ts`. A getter, read at send time: a viewer can arrive or
   * leave between two notifications.
   */
  viewers?: (agentId: string) => Set<string>;
  /**
   * Every subscribed device's key. Needed to answer "is EVERY device already
   * showing this?", which is a different question from "is anyone".
   *
   * Synchronous, which is why `push.json` persists the key rather than this
   * hashing endpoints on demand: an await here would sit between reading the
   * cooldown and stamping it.
   */
  pushDeviceKeys?: () => Set<string>;
```

change `sendPush`'s payload to include `skipDeviceKeys: Set<string>`, and add beside the other module constants:

```ts
/** Shared empty set, so the no-presence path allocates nothing per send. */
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();
```

In `#fire`, immediately after the mute check and BEFORE the cooldown block:

```ts
    // WHO IS ALREADY LOOKING. Decided here, above the cooldown stamp, and the
    // position is the point: a withheld push makes no request at all, so there
    // is nothing to rate-limit, and spending the cooldown would delay the
    // deferred re-fire by up to `cooldownMs` for no reason anyone could name.
    // The stamp's own comment is about a send that was MADE and FAILED, which
    // this is not.
    const skip = s.notify.skipWhileViewing
      ? this.o.viewers?.(a.agentId) ?? EMPTY_KEYS
      : EMPTY_KEYS;
    const roster = this.o.pushDeviceKeys?.() ?? EMPTY_KEYS;
    // `roster.size > 0` guards the case where nothing is subscribed: an empty
    // roster is not suppression, and reading it as "every device is viewing"
    // would silence push for an operator with no devices to silence.
    const pushWithheld = roster.size > 0 && [...roster].every((k) => skip.has(k));
    // Task 5 replaces this with the deferral. Returning here is already
    // correct for "withhold"; what it lacks is the memory to fire later.
    if (pushWithheld && !telegramReady) return;
```

Pass the skip set down:

```ts
    const pushed = this.#sendPush(a, state, skip);
```

```ts
  async #sendPush(a: Agent, state: NotifyTrigger, skipDeviceKeys: ReadonlySet<string>): Promise<void> {
    const send = this.o.sendPush;
    if (send === undefined) return;
    try {
      await send({ name: a.name, state, agentId: a.agentId, skipDeviceKeys: new Set(skipDeviceKeys) });
    } catch (e) {
      console.info(`paddock: push failed for ${a.name}: ${(e as Error).message}`);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/notifier-presence.test.ts tests/notify-wiring.test.ts tests/notifier-push.test.ts tests/notifier.test.ts tests/notifier-settle.test.ts tests/notifier-timing.test.ts tests/notifier-inflight.test.ts`
Expected: PASS. Every existing notifier suite must be green unchanged — they construct no presence getters, which is the "behaves as today" path.

- [ ] **Step 5: Typecheck, scan, commit**

```bash
make check && make check-clean
git add src/server/notify/notifier.ts src/server/index-wiring.ts tests/notifier-presence.test.ts tests/notify-wiring.test.ts
git commit -m "feat: withhold a push from the device already showing that agent"
```

---

### Task 5: Deferral, and the wiring that releases it

**Files:**
- Modify: `src/server/notify/notifier.ts`, `src/server/index.ts`
- Test: `tests/notifier-presence.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `Notifier.reconsider(agentId: string): void`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/notifier-presence.test.ts`:

```ts
test("a withheld notification fires when the viewer leaves", async () => {
  // The failure this exists to prevent: look at an agent as it blocks, pocket
  // the phone ten seconds later without answering, and nothing ever tells you.
  const push: PushPayload[] = [];
  let looking = true;
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => (looking ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
    cooldownMs: 0,
  });
  await settleBlocked(n);
  expect(push).toEqual([]);

  looking = false;
  n.reconsider("w1:p1");
  await Bun.sleep(5);
  expect(push).toHaveLength(1);
  expect(push[0]!.name).toBe("flaky-test-fix");
});

test("a withheld send does not spend the cooldown", async () => {
  // If the withheld path stamped `#lastSentAt`, this deferral would wait out a
  // full cooldown after the viewer left — a minute of silence, by default, for
  // a send that never happened. The clock is frozen at NOW, so a spent
  // cooldown means the assertion below sees nothing.
  const push: PushPayload[] = [];
  let looking = true;
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => (looking ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
    cooldownMs: 60_000,
  });
  await settleBlocked(n);
  looking = false;
  n.reconsider("w1:p1");
  await Bun.sleep(5);
  expect(push).toHaveLength(1);
});

test("an agent that unblocked while you watched it notifies nobody later", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
    cooldownMs: 0,
  });
  await settleBlocked(n);
  // Answered on the spot: the episode is over and the deferral has nothing
  // true left to say.
  n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  await Bun.sleep(5);
  n.reconsider("w1:p1");
  await Bun.sleep(5);
  expect(push).toEqual([]);
});

test("blocked, watched, unblocked and blocked again fires once", async () => {
  // The episode trap. A deferral from the FIRST blocked episode must not fire
  // against the second, and must not double up with it.
  const push: PushPayload[] = [];
  let looking = true;
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => (looking ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
    cooldownMs: 0,
  });
  await settleBlocked(n);              // deferred, episode 1
  n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  await Bun.sleep(5);
  looking = false;
  n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(5);                  // episode 2 sends: nobody is looking
  n.reconsider("w1:p1");               // episode 1's deferral, now void
  await Bun.sleep(5);
  expect(push).toHaveLength(1);
});

test("a deferral is dropped when the agent goes away", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
    cooldownMs: 0,
  });
  await settleBlocked(n);
  n.observe({ upserted: [], removedIds: ["w1:p1"] });
  n.reconsider("w1:p1");
  await Bun.sleep(5);
  expect(push).toEqual([]);
});

test("reconsider for an agent with nothing deferred does nothing", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({ sendPush: async (p) => { push.push(p); } });
  n.reconsider("w1:p1");
  await Bun.sleep(5);
  expect(push).toEqual([]);
});

test("mute discards a deferral rather than queuing it", async () => {
  // `mutedUntil` drops rather than queues — a pile delivered when mute lifts
  // describes agents unblocked hours earlier. A deferral surviving mute would
  // be exactly that pile, one entry at a time.
  const push: PushPayload[] = [];
  let looking = true;
  let muted = false;
  const store = {
    current: () => ({
      telegram: { token: "", chatId: "" },
      notify: {
        telegram: true, triggers: ["blocked"], settleMs: { blocked: 0, done: 0 },
        mutedUntil: muted ? NOW + 60_000 : null, cooldownMs: 0, skipWhileViewing: true,
      },
      push: { enabled: true },
      publicUrl: null,
    }),
  };
  const n = new Notifier({
    settings: store as never,
    send: async () => ({ ok: true, detail: null }),
    sendPush: async (p) => { push.push(p as PushPayload); },
    viewers: () => (looking ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
    now: () => NOW,
  });
  await settleBlocked(n);        // deferred
  muted = true;
  looking = false;
  n.reconsider("w1:p1");         // meets the mute
  await Bun.sleep(5);
  muted = false;
  n.reconsider("w1:p1");         // and there is nothing left to release
  await Bun.sleep(5);
  expect(push).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/notifier-presence.test.ts`
Expected: FAIL — `n.reconsider is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/server/notify/notifier.ts`, add the map beside `#pending`:

```ts
  /**
   * Episodes withheld because every subscribed device was already showing the
   * agent, waiting for a viewer to leave.
   *
   * DEFERRED, NOT DROPPED, and that is the whole reason this map exists: look
   * at an agent as it blocks, pocket the phone ten seconds later without
   * answering, and dropping would mean nothing ever tells you. The same
   * defer-not-drop rule the cooldown follows, for the same reason — losing a
   * real event to prevent a duplicate one is the worse trade.
   *
   * Holds the AGENT, not just its id, matching what the retry path already
   * closes over: a rename between deferral and fire shows the old name, which
   * is already true of a retry and not worth a second mechanism.
   */
  #deferred = new Map<string, {
    agent: Agent; state: NotifyTrigger; episode: number; attempts: number;
  }>();
```

In `#see`, beside `this.#lastNotified.delete(a.agentId)`:

```ts
    // The episode this deferral belonged to is over. Left in place, a later
    // `reconsider` would announce a state the agent has already left.
    this.#deferred.delete(a.agentId);
```

In `#forget`, beside the other deletes: `this.#deferred.delete(agentId);`
In `dispose()`, after clearing `#pending`: `this.#deferred.clear();`

In `#fire`, on the mute path:

```ts
    if (s.notify.mutedUntil !== null && now < s.notify.mutedUntil) {
      // A deferral held for this agent is discarded with the notification, or
      // mute lifting would deliver exactly the pile this rule prevents.
      this.#deferred.delete(a.agentId);
      return;
    }
```

and replace Task 4's placeholder return:

```ts
    if (pushWithheld && !telegramReady) {
      this.#deferred.set(a.agentId, { agent: a, state, episode, attempts });
      return;
    }
    // Something is about to be delivered, so this episode is no longer waiting
    // on a viewer.
    this.#deferred.delete(a.agentId);
```

Add the public entry point next to `dispose()`:

```ts
  /**
   * Look again at an agent whose viewers may have gone away.
   *
   * Called from `state/presence.ts`'s change events — a navigation, a
   * backgrounded page, a closed socket, or a TTL expiry. It ASSERTS NOTHING
   * itself: it re-arms at zero delay and `#fire` re-reads triggers, mute,
   * presence and the cooldown. That is deliberate — a release is a reason to
   * re-decide, not a decision.
   */
  reconsider(agentId: string): void {
    const d = this.#deferred.get(agentId);
    if (d === undefined) return;
    // The state moved on, or this pane's episode is over. Arming either would
    // cancel a LIVE timer to install a send that then declines to fire, which
    // is how the operator loses the notification they were waiting for.
    if (this.#lastSeen.get(agentId) !== d.state || this.#episode.get(agentId) !== d.episode) {
      this.#deferred.delete(agentId);
      return;
    }
    this.#arm(d.agent, d.state, 0, d.attempts, d.episode);
  }
```

In `src/server/index.ts`, construct presence before the notifier:

```ts
/**
 * Who is looking at what. Written by the WebSocket layer, read by the
 * notifier; neither knows about the other.
 */
const presence = new PresenceStore();
presence.startSweep();
```

Add to the `new Notifier({...})` options:

```ts
  viewers: (agentId) => presence.viewers(agentId),
  // A synchronous read of what `push.json` already stores — see
  // `StoredSubscription.deviceKey` for why it is not hashed here.
  pushDeviceKeys: () => push.deviceKeys(),
```

After the notifier exists:

```ts
// A viewer leaving is what releases a withheld notification. Includes TTL
// expiry, which the presence store emits as an ordinary change.
presence.onChange((agentId) => notifier.reconsider(agentId));
```

Pass `presence` into `hubWebSocket({ ... })` and into the `tunnel/run.ts` deps, and add `presence.dispose()` to the shutdown path beside `notifier.dispose()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `make test`
Expected: PASS — the whole suite, including every existing notifier file.

- [ ] **Step 5: Typecheck, scan, commit**

```bash
make check && make check-clean
git add src/server/notify/notifier.ts src/server/index.ts tests/notifier-presence.test.ts
git commit -m "feat: hold a withheld notification until its viewer leaves"
```

---

### Task 6: The setting

**Files:**
- Modify: `src/shared/types.ts`, `src/server/settings/store.ts`, `src/server/routes.ts`, `src/web/components/Settings.tsx`, `src/web/components/settings/NotifySection.tsx`
- Test: `tests/settings-store.test.ts`, `tests/settings-routes.test.ts`, `tests/notify-card.test.tsx` (append to each)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SettingsView["notify"].skipWhileViewing: boolean`; `NotifySectionProps.skipWhileViewing: boolean` and `setSkipWhileViewing: (v: boolean) => void`.

**The default is `false` in this task and flipped to `true` in Task 8**, so a half-wired branch can never withhold a real notification.

- [ ] **Step 1: Write the failing tests**

Append to `tests/settings-store.test.ts`:

```ts
test("skipWhileViewing defaults off while the feature lands", async () => {
  const s = new SettingsStore(await dir(), {});
  await s.load();
  expect(s.current().notify.skipWhileViewing).toBe(false);
});

test("a non-boolean skipWhileViewing falls back to the default", async () => {
  // A hand-edited settings.json is a documented use, so a wrong type must
  // degrade rather than throw — the rule `triggers` and `settleMs` follow.
  expect(migrate({ notify: { skipWhileViewing: "yes" } }, () => {}).notify.skipWhileViewing)
    .toBe(false);
});

test("a stored skipWhileViewing survives a load", async () => {
  expect(migrate({ notify: { skipWhileViewing: true } }, () => {}).notify.skipWhileViewing)
    .toBe(true);
});
```

Append to `tests/settings-routes.test.ts`, following that file's existing PUT helper and its name:

```ts
test("notify.skipWhileViewing must be a boolean", async () => {
  const res = await put({ notify: { skipWhileViewing: "yes" } });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("skipWhileViewing");
});

test("notify.skipWhileViewing is accepted and reflected in the view", async () => {
  const res = await put({ notify: { skipWhileViewing: true } });
  expect(res.status).toBe(200);
  expect((await res.json()).notify.skipWhileViewing).toBe(true);
});
```

Append to `tests/notify-card.test.tsx`, and add `skipWhileViewing: false, setSkipWhileViewing: () => {}` to its `props()` fixture:

```ts
test("the watching setting states what it does to push, and to Telegram", async () => {
  // A feature that withholds a buzz reads as a broken feature unless the UI
  // says otherwise — and it must not appear to govern Telegram, which presence
  // cannot speak for.
  const host = await render(<NotifySection {...props()} />);
  const text = host.textContent ?? "";
  expect(text).toContain("Skip push for the agent I'm watching");
  expect(text).toContain("waits until you leave");
  expect(text).toContain("Telegram");
});

test("the watching checkbox reports its state", async () => {
  const host = await render(<NotifySection {...props({ skipWhileViewing: true })} />);
  const box = host.querySelector('[aria-label="Skip push for the agent I\'m watching"]');
  expect(box?.getAttribute("data-state")).toBe("checked");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/settings-store.test.ts tests/settings-routes.test.ts && make test`
Expected: FAIL — the field does not exist; `NotifySectionProps` has no `skipWhileViewing`.

- [ ] **Step 3: Write the implementation**

In `src/shared/types.ts`, inside `SettingsView["notify"]`:

```ts
    /**
     * Withhold a push from a device that is currently showing that agent's
     * pane, until it stops showing it.
     *
     * Push ONLY. A device key identifies one browser; a Telegram chat can be
     * read from a laptop, so presence can make no claim about it.
     */
    skipWhileViewing: boolean;
```

In `src/server/settings/store.ts`, add `skipWhileViewing: false` to `defaults().notify` and, in `migrate`'s returned `notify` object:

```ts
      skipWhileViewing: typeof n.skipWhileViewing === "boolean"
        ? n.skipWhileViewing : d.notify.skipWhileViewing,
```

In `src/server/routes.ts`, inside the `notify` branch beside the `cooldownMs` check:

```ts
    if ("skipWhileViewing" in nn) {
      if (typeof nn.skipWhileViewing !== "boolean") {
        return { ok: false, detail: "notify.skipWhileViewing must be a boolean" };
      }
      out.skipWhileViewing = nn.skipWhileViewing;
    }
```

In `src/web/components/settings/NotifySection.tsx`, add the two props to `NotifySectionProps` and render the control beside the transport checkboxes:

```tsx
        <label className="notify-transport">
          <Checkbox
            checked={skipWhileViewing}
            aria-label="Skip push for the agent I'm watching"
            onCheckedChange={(v) => setSkipWhileViewing(v === true)}
          />
          <span>
            Skip push for the agent I&apos;m watching
            <small>
              While a device has this agent&apos;s pane open, push to that
              device waits until you leave it. Other devices and Telegram are
              unaffected.
            </small>
          </span>
        </label>
```

In `src/web/components/Settings.tsx`, follow `pushOn` exactly — `useState(false)`, the `baseline.notify.skipWhileViewing` comparison in the dirty check, `setSkipWhileViewing(body.notify.skipWhileViewing)` in the load, `skipWhileViewing` in the `patch.notify` object, and both props passed to `<NotifySection>`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `make test`
Expected: PASS.

- [ ] **Step 5: Typecheck, scan, commit**

```bash
make check && make check-clean
git add src/shared/types.ts src/server/settings/store.ts src/server/routes.ts src/web/components/Settings.tsx src/web/components/settings/NotifySection.tsx tests/settings-store.test.ts tests/settings-routes.test.ts tests/notify-card.test.tsx
git commit -m "feat: a setting for skipping push on the agent you are watching"
```

---

### Task 7: Clearing a notification that no longer describes anything

**Independent of Tasks 1–6.** It answers the second complaint on its own and can ship alone if the rest slips.

**Files:**
- Create: `src/web/notifications.ts`, `tests/notification-sweep.test.ts`
- Modify: `src/web/components/App.tsx`
- Test: `tests/notification-sweep.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `closeFor(agentId: string): Promise<void>`, `sweep(agents: Agent[]): Promise<void>`, `useNotificationSweep(agents: Agent[]): void`.

- [ ] **Step 1: Write the failing tests**

Create `tests/notification-sweep.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { closeFor, sweep } from "@web/notifications";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "schema-migration",
  task: "Add the index", state: "blocked", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", harness: "claude",
  stateSince: NOW, stateSinceExact: true,
  updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
});

/** One notification, and whether the sweep closed it. */
function note(tag: string) {
  return { tag, closed: false, close() { this.closed = true; } };
}

/**
 * Fake `navigator.serviceWorker`, installed the way `push-section.test.tsx`
 * does it: on the existing navigator, saved and restored, because Bun ships a
 * navigator without a service worker.
 *
 * `notes === null` models a registration with no `getNotifications` at all —
 * a browser where the API does not exist.
 */
function fakeSw(notes: ReturnType<typeof note>[] | null) {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, "serviceWorker");
  const registration = notes === null ? {} : {
    getNotifications: async (o?: { tag?: string }) =>
      notes.filter((n) => o?.tag === undefined || n.tag === o.tag),
  };
  Object.defineProperty(nav, "serviceWorker", {
    value: { getRegistration: async () => registration },
    configurable: true, writable: true,
  });
  return () => {
    if (had) Object.defineProperty(nav, "serviceWorker", had);
    else delete nav.serviceWorker;
  };
}

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

test("a notification for an agent that is working again is closed", async () => {
  // The complaint this fixes: answer the agent from the herdr terminal on the
  // laptop and the phone's lock screen still says it is waiting.
  const notes = [note("w1:p1")];
  restore = fakeSw(notes);
  await sweep([agent({ state: "working" })]);
  expect(notes[0]!.closed).toBe(true);
});

test("a notification for an agent still blocked is left alone", async () => {
  const notes = [note("w1:p1")];
  restore = fakeSw(notes);
  await sweep([agent({ state: "blocked" })]);
  expect(notes[0]!.closed).toBe(false);
});

test("a notification for a done agent is left alone", async () => {
  // `done` is a trigger too, and a finished agent you have not looked at is
  // still news.
  const notes = [note("w1:p1")];
  restore = fakeSw(notes);
  await sweep([agent({ state: "done" })]);
  expect(notes[0]!.closed).toBe(false);
});

test("a notification for an agent that no longer exists is closed", async () => {
  const notes = [note("w9:p9")];
  restore = fakeSw(notes);
  await sweep([agent()]);
  expect(notes[0]!.closed).toBe(true);
});

test("an untagged notification is never swept", async () => {
  // `sw.js` falls back to "paddock: an agent needs you" with an empty tag when
  // a payload arrives it cannot read. The sweep cannot tell what that one is
  // about, so closing it would discard the only trace of a real event.
  const notes = [note("")];
  restore = fakeSw(notes);
  await sweep([]);
  expect(notes[0]!.closed).toBe(false);
});

test("closeFor closes only that agent's notification", async () => {
  const notes = [note("w1:p1"), note("w2:p1")];
  restore = fakeSw(notes);
  await closeFor("w1:p1");
  expect(notes.map((n) => n.closed)).toEqual([true, false]);
});

test("a browser without getNotifications is not an error", async () => {
  // Capability detection, not a swallowed failure: the API genuinely does not
  // exist everywhere paddock is opened, and there is nothing to report.
  restore = fakeSw(null);
  await sweep([agent()]);
  await closeFor("w1:p1");
});

test("a browser without a service worker at all is not an error", async () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, "serviceWorker");
  delete nav.serviceWorker;
  restore = () => { if (had) Object.defineProperty(nav, "serviceWorker", had); };
  await sweep([agent()]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/notification-sweep.test.ts`
Expected: FAIL — `Cannot find module '@web/notifications'`.

- [ ] **Step 3: Write the implementation**

Create `src/web/notifications.ts`:

```ts
import { useEffect } from "react";
import type { Agent } from "@shared/types";

/**
 * Closing notifications that no longer describe anything.
 *
 * `public/sw.js` is NOT involved and is not touched: it already tags every
 * notification with the agent id, which is everything this needs. That keeps
 * the no-`fetch`-handler assertion in `tests/sw.test.ts` true and leaves
 * decision 23 unamended.
 *
 * The alternative — pushing on `blocked -> working` with a flag telling the
 * worker to close the tag and render nothing — would clear the lock screen
 * without the phone being touched, which is why it will keep getting proposed.
 * WebKit counts a push that shows no notification against the subscription and
 * can revoke it, so this sweep is the version that does not spend the
 * subscription to save a buzz.
 */

/** The states a notification can still be TRUE about. */
const LIVE = new Set<Agent["state"]>(["blocked", "done"]);

async function registration(): Promise<ServiceWorkerRegistration | null> {
  const sw = globalThis.navigator?.serviceWorker;
  // Capability detection, not a swallowed error: a browser with no service
  // worker has no notifications to close, and nothing has failed.
  if (sw === undefined) return null;
  try {
    return (await sw.getRegistration()) ?? null;
  } catch (e) {
    console.info(`paddock: could not reach the service worker: ${(e as Error).message}`);
    return null;
  }
}

/** Close this agent's notification. Called when you open its pane. */
export async function closeFor(agentId: string): Promise<void> {
  const reg = await registration();
  if (reg?.getNotifications === undefined) return;
  for (const n of await reg.getNotifications({ tag: agentId })) n.close();
}

/**
 * Close every notification that is no longer true.
 *
 * An UNTAGGED notification is never closed. `sw.js` falls back to
 * "paddock: an agent needs you" with an empty tag when it cannot read a
 * payload, and this cannot tell what that one was about — discarding it would
 * throw away the only trace of a real event.
 */
export async function sweep(agents: Agent[]): Promise<void> {
  const reg = await registration();
  if (reg?.getNotifications === undefined) return;
  const live = new Set(agents.filter((a) => LIVE.has(a.state)).map((a) => a.agentId));
  for (const n of await reg.getNotifications()) {
    if (n.tag !== "" && !live.has(n.tag)) n.close();
  }
}

/**
 * Sweep when the app comes forward, and whenever the agents move.
 *
 * The second trigger is not redundant: if you are already in the app when an
 * agent finishes, its stale alert should clear without needing a
 * background-and-return cycle.
 *
 * Keyed on the id-and-state SET rather than the array, the same way `App.tsx`
 * keys its cache eviction — a new array identity every render would sweep on
 * every render.
 */
export function useNotificationSweep(agents: Agent[]): void {
  const key = agents.map((a) => `${a.agentId}:${a.state}`).sort().join(" ");
  useEffect(() => {
    void sweep(agents);
    const onVisible = () => { if (!document.hidden) void sweep(agents); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [key]);
}
```

In `src/web/components/App.tsx`, beside the existing hooks (`openId` is already in scope from `useAgentRoute()`):

```tsx
  useNotificationSweep(agents);
  useEffect(() => {
    // You are looking at it. Whatever the lock screen still says about this
    // agent, it is no longer news.
    if (openId !== null) void closeFor(openId);
  }, [openId]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `make test`
Expected: PASS.

- [ ] **Step 5: Typecheck, scan, commit**

```bash
make check && make check-clean
git add src/web/notifications.ts src/web/components/App.tsx tests/notification-sweep.test.ts
git commit -m "fix: clear notifications that no longer describe anything"
```

---

### Task 8: Turn it on, and write down why

**Files:**
- Modify: `src/server/settings/store.ts`, `tests/settings-store.test.ts`, `docs/architecture.md`, `docs/settings.md`, `docs/decisions.md`, `docs/gotchas.md`, `docs/design/2026-08-26-notification-presence-design.md`

- [ ] **Step 1: Flip the default and update its tests**

In `src/server/settings/store.ts`, `defaults().notify.skipWhileViewing` becomes `true`. In `tests/settings-store.test.ts`, replace the Task 6 default test:

```ts
test("skipWhileViewing is on by default", async () => {
  // On by default because the duplicate buzz is the complaint, and the
  // deferral means nothing is lost by defaulting to quiet.
  const s = new SettingsStore(await dir(), {});
  await s.load();
  expect(s.current().notify.skipWhileViewing).toBe(true);
});
```

and change the fallback test's expectation to `true` in the same pass — `migrate({ notify: { skipWhileViewing: "yes" } })` now falls back to the new default.

- [ ] **Step 2: Run the full suite**

Run: `make test`
Expected: PASS. Any failure here is a test that assumed push always sends — read it before changing it.

- [ ] **Step 3: Write the documentation**

- `docs/architecture.md` — `src/server/state/presence.ts` in the module list, with one line on why it sits there: written by `ws/serve.ts`, read by `notify/`, imports neither.
- `docs/settings.md` — `notify.skipWhileViewing`, default `true`, push only.
- `docs/decisions.md` — decision 24, in the file's numbered style: why presence is keyed by connection and matched per device rather than globally, why it governs push and never Telegram, and why both the service-worker-local suppression and the silent clearing push were rejected on WebKit's push budget.
- `docs/gotchas.md` — a row for **herdr's `focused` is not "a human is watching"**: it survives a closed lid, so suppressing on it silences exactly the agent you walked away from.
- `docs/design/2026-08-26-notification-presence-design.md` — amend the `deviceKey` section: the hash is persisted in `push.json` at subscribe time and backfilled on load, not computed per notification at the composition root, so the notifier's roster getter stays synchronous. State the reason (an await above the cooldown stamp would open an interleaving window `#fire` does not have) so it reads as a decision rather than a drift.

- [ ] **Step 4: Verify the whole thing**

```bash
make check && make check-clean && make test
```

Then drive it by hand, which no test in this plan covers: `make dev`, open two browsers, put one on an agent's pane, block that agent, and confirm the viewing browser gets no notification while the other does — then close the viewing tab and confirm the held notification arrives.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: turn on presence-aware push, and record the reasoning"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: the four rules to Tasks 4–6, the rejected alternatives to Task 8's decision entry, presence to Task 1, the wire and its validation to Task 3, `deviceKey` to Task 2, the notifier to Tasks 4–5, clearing to Task 7, the setting to Task 6, docs and sequencing to Task 8. The spec's six-step sequence maps to Tasks 1 → 3 → 2 → 4 → 5 → 6 → 7, with the default-off-then-flip discipline preserved.

**One deliberate divergence**, recorded in File Structure above and amended into the spec in Task 8: `deviceKey` is persisted per subscription instead of hashed at the composition root, so the notifier's roster getter is synchronous and no await lands between reading the cooldown and stamping it.

**Type consistency.** `hashEndpoint` is the only hash function, lives in `@shared/device-key`, and is used by both `src/web/device-key.ts` and `src/server/push/store.ts`. `skipDeviceKeys` is the same name in `NotifierOpts.sendPush`, `buildPushSender`, and both test files. `viewers` returns `Set<string>` everywhere; `EMPTY_KEYS` is `ReadonlySet<string>` and `#sendPush` copies it into a `Set` at the boundary so the transport's parameter type stays mutable-compatible. `reconsider(agentId: string): void` is the same signature in `notifier.ts`, `index.ts`'s `onChange` wiring, and the Task 5 tests. `PresenceStore.set` takes `{ deviceKey, agentId }` in Task 1, Task 3's `message()` handler, and the Task 1 tests.

**No placeholders.** Every step names its files, shows the code, and gives a command with an expected result.
