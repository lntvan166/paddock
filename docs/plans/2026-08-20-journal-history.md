# Journal History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace paddock's reconstructed scrollback with the coding agent's own on-disk session log, so "Show earlier" goes deeper and stops having gaps.

**Architecture:** A new `src/server/journal/` reads the harness's JSONL session log, flattens it to text lines server-side, and serves them from a paginated `POST /api/agents/:id/history`. herdr supplies the session id on `agent.list`. The client keeps its current terminal view and only changes where earlier lines come from. Where no journal exists, today's client-side reconstruction is untouched.

**Tech Stack:** Bun, TypeScript, Hono, React, `bun:test`.

**Spec:** `docs/design/2026-08-20-journal-history-design.md` — read it first; this plan argues from it.

## Global Constraints

- **This repository is public.** No hostnames, home paths, usernames, employer terms, or real agent names — in code, comments, fixtures, tests, or commit messages. Fixtures use invented names: `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`. Run `make check-clean` before every commit; if it fails, fix the content, never the denylist.
- **Dependency direction:** `herdr/socket → herdr/adapter → state/store → ws/hub → web/`. `journal/` is a NEW axis beside `herdr/` — it knows about *harnesses*, never about herdr, and never imports from `herdr/`. `adapter.ts` must not import `journal/` either; the predicate it needs is injected (Task 2).
- **`src/shared/types.ts` is the one payload contract.** Never redeclare a payload shape on the UI side.
- **`src/shared/herdr-api.d.ts` is generated** by `make types`. Never hand-edit it.
- **Never swallow errors.** No `2>/dev/null`, no empty catch blocks. A skipped JSONL line is logged; a failed journal read is reported in the response `detail` and logged once per agent.
- **Never put payloads in a GET query string.** POST bodies only.
- **Gate before every commit:** `make check && make check-clean && make test`.
- **House rule 4:** before trusting a new test, break the thing it guards and watch it go red.
- Claude Code journal shape was verified against the version recorded in `journal/claude.ts`'s header. Re-verify and update that header whenever the shape is re-checked.

---

### Task 1: `agent_session` reaches paddock's generated types

herdr already sends it; paddock's generated `herdr-api.d.ts` does not declare it, so nothing downstream can read it.

**Files:**
- Modify: `scripts/gen-herdr-types.ts` (the `HerdrAgentRaw` template literal, around line 62)
- Modify: `src/shared/herdr-api.d.ts` (regenerated, never hand-edited)
- Test: `tests/herdr-types-guard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HerdrAgentSession` (`{ agent: string; kind: string; source: string; value: string }`) and `HerdrAgentRaw.agent_session?: HerdrAgentSession | null`, both exported from `@shared/herdr-api`.

- [ ] **Step 1: Write the failing test**

Add to `tests/herdr-types-guard.test.ts`:

```ts
test("HerdrAgentRaw declares agent_session, the key journal history needs", () => {
  // A generated file, so this asserts the GENERATOR emitted it. herdr 0.8.2
  // sends agent_session on every agent.list row; without it in the declared
  // shape, journal/ has no session id to look up and the feature is dead at
  // the type level rather than at runtime.
  const src = readFileSync("src/shared/herdr-api.d.ts", "utf8");
  expect(src).toContain("export interface HerdrAgentSession");
  expect(src).toMatch(/agent_session\?: HerdrAgentSession \| null;/);
});
```

Ensure `readFileSync` is imported at the top of that file: `import { readFileSync } from "node:fs";`

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/herdr-types-guard.test.ts`
Expected: FAIL — `expect(received).toContain("export interface HerdrAgentSession")`.

- [ ] **Step 3: Emit the type from the generator**

In `scripts/gen-herdr-types.ts`, immediately before the `/** One entry from \`agent.list\` ... */` block, add:

```ts
/**
 * The harness session herdr has associated with a pane, or null.
 *
 * \`kind\` is "id" for a session identifier and \`value\` is that id;
 * \`agent\` names the harness ("claude", "codex"). This is the key
 * \`src/server/journal/\` uses to find the harness's own log, and it is why
 * that feature needs no second herdr call: it rides on \`agent.list\`.
 */
export interface HerdrAgentSession {
  agent: string;
  kind: string;
  source: string;
  value: string;
}
```

Then add this line inside the `HerdrAgentRaw` interface body, after `agent_status`:

```ts
  agent_session?: HerdrAgentSession | null;
```

- [ ] **Step 4: Regenerate and verify**

Run: `make types && bun test tests/herdr-types-guard.test.ts`
Expected: PASS. `git diff src/shared/herdr-api.d.ts` shows only the two additions.

- [ ] **Step 5: Confirm the live schema agrees**

Run: `herdr api schema --json | grep -c agent_session`
Expected: non-zero. If zero, STOP — the installed herdr predates the field and the rest of this plan cannot work; report it rather than proceeding.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add scripts/gen-herdr-types.ts src/shared/herdr-api.d.ts tests/herdr-types-guard.test.ts
git commit -m "feat: generate agent_session, the key a journal lookup needs"
```

---

### Task 2: `hasJournal` on the wire, session ids off it

The browser must learn *whether* history exists without ever receiving a filesystem key.

**Files:**
- Modify: `src/shared/types.ts` (the `Agent` interface)
- Modify: `src/server/herdr/adapter.ts` (`AdaptContext`, `toAgent`, new `sessionRefs`)
- Modify: `src/server/supervisor.ts:257` (the `toAgents` call)
- Test: `tests/adapter.test.ts`

**Interfaces:**
- Consumes: `HerdrAgentSession`, `HerdrAgentRaw` from Task 1.
- Produces:
  - `Agent.hasJournal: boolean` (required, not optional).
  - `AdaptContext.hasJournal?: (session: HerdrAgentSession | null | undefined) => boolean` — injected predicate, defaults to `() => false`.
  - `sessionRefs(rows: HerdrAgentRaw[]): Map<string, HerdrAgentSession>` keyed by `pane_id`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/adapter.test.ts` (reuse that file's existing `raw()` helper; pass `agent_session` through it):

```ts
test("hasJournal is false when herdr sends no session", () => {
  const [a] = toAgents([raw({ pane_id: "w1:p1", name: "api-refactor" })], ctx());
  expect(a!.hasJournal).toBe(false);
});

test("hasJournal asks the injected predicate, never the harness name directly", () => {
  // Injected, because `adapter.ts` sits on the herdr axis and `journal/` sits
  // on the harness axis. A direct import would tie the two together and put
  // harness knowledge in the herdr adapter.
  const session = { agent: "claude", kind: "id", source: "herdr:claude", value: "u" };
  const [a] = toAgents([raw({ pane_id: "w1:p1", agent_session: session })], {
    ...ctx(),
    hasJournal: (s) => s?.agent === "claude",
  });
  expect(a!.hasJournal).toBe(true);
});

test("sessionRefs keys by pane id and drops rows with no session", () => {
  const session = { agent: "claude", kind: "id", source: "herdr:claude", value: "u1" };
  const refs = sessionRefs([
    raw({ pane_id: "w1:p1", agent_session: session }),
    raw({ pane_id: "w1:p2" }),
  ]);
  expect(refs.get("w1:p1")).toEqual(session);
  expect(refs.has("w1:p2")).toBe(false);
});

test("the session id is NOT on the wire type", () => {
  // A session id is a filesystem key. The browser cannot need one, and paddock
  // does not hand filesystem keys to clients. Asserted on the serialized shape
  // because that is what actually crosses the socket.
  const session = { agent: "claude", kind: "id", source: "herdr:claude", value: "secret-uuid" };
  const [a] = toAgents([raw({ pane_id: "w1:p1", agent_session: session })], ctx());
  expect(JSON.stringify(a)).not.toContain("secret-uuid");
});
```

Import `sessionRefs` alongside `toAgents` at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/adapter.test.ts`
Expected: FAIL — `sessionRefs` is not exported; `hasJournal` is undefined.

- [ ] **Step 3: Add the field to the payload contract**

In `src/shared/types.ts`, inside `interface Agent`, after `acknowledgedAt`:

```ts
  /**
   * Whether paddock can read this agent's own session log, which decides
   * WHICH history source the terminal view uses (see
   * `docs/design/2026-08-20-journal-history-design.md`).
   *
   * A boolean and nothing more, deliberately. The session id it is derived
   * from is a filesystem key that stays on the server: the UI's only question
   * is "fetch, or use my local reconstruction?".
   *
   * Required, not optional — an optional field lets a future edit drop it
   * silently, and the terminal would fall back to reconstruction for every
   * agent with nothing to notice.
   */
  hasJournal: boolean;
```

- [ ] **Step 4: Implement in the adapter**

In `src/server/herdr/adapter.ts`, extend `AdaptContext`:

```ts
export interface AdaptContext {
  hostId: string;
  labels: Map<string, string>;
  now: number;
  /**
   * Whether a journal adapter exists for this session. INJECTED rather than
   * imported: `journal/` is a harness-axis module and this file is the herdr
   * adapter, so importing it here would cross the two axes permanently.
   * Defaults to false, which is exactly "paddock reads no journals".
   */
  hasJournal?: (session: HerdrAgentSession | null | undefined) => boolean;
}
```

Add to the object literal returned by `toAgent`, after `acknowledgedAt`:

```ts
    hasJournal: ctx.hasJournal?.(rawAgent.agent_session) ?? false,
```

Add at the end of the file:

```ts
/**
 * Session ids by pane id, for the server side only.
 *
 * Separate from `toAgents` because the result must NOT travel with the agent:
 * `Agent` crosses the socket to the browser and this does not.
 */
export function sessionRefs(rows: HerdrAgentRaw[]): Map<string, HerdrAgentSession> {
  const out = new Map<string, HerdrAgentSession>();
  for (const row of rows) {
    if (row.agent_session) out.set(row.pane_id, row.agent_session);
  }
  return out;
}
```

Import the type: add `HerdrAgentSession` to the existing `@shared/herdr-api` import.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/adapter.test.ts`
Expected: PASS. `bunx tsc --noEmit` will now fail wherever an `Agent` literal is built without `hasJournal` — fix each by adding `hasJournal: false` (tests, `src/web/demo/backend.ts`, fixtures). That is the required-field guarantee working.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add -A
git commit -m "feat: hasJournal on the wire, session ids off it"
```

---

### Task 3: the journal registry and its types

Pure module: no filesystem, no herdr. It answers "which adapter, if any".

**Files:**
- Create: `src/server/journal/types.ts`
- Create: `src/server/journal/registry.ts`
- Test: `tests/journal-registry.test.ts`

**Interfaces:**
- Consumes: `HerdrAgentSession` (Task 1).
- Produces:
  - `interface JournalEntry { role: "user" | "assistant"; at: string | null; text: string; tools: string[] }`
  - `interface JournalAdapter { name: string; verifiedAgainst: string; locate(value: string, roots: readonly string[]): Promise<string | null>; parse(chunk: string): JournalEntry[] }`
  - `interface JournalRoots { claude: readonly string[] }`
  - `adapterFor(session: HerdrAgentSession | null | undefined): JournalAdapter | null`
  - `hasAdapter(session: HerdrAgentSession | null | undefined): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/journal-registry.test.ts`:

```ts
import { expect, test } from "bun:test";
import { adapterFor, hasAdapter } from "@server/journal/registry";

const claude = { agent: "claude", kind: "id", source: "herdr:claude", value: "u1" };

test("a claude session resolves to the claude adapter", () => {
  expect(adapterFor(claude)?.name).toBe("claude");
  expect(hasAdapter(claude)).toBe(true);
});

test("a harness with no adapter is an ordinary no, not an error", () => {
  // The route reports this as `source: "reconstruction"`, so an unknown
  // harness must be a null rather than a throw.
  expect(adapterFor({ ...claude, agent: "some-other-harness" })).toBeNull();
  expect(hasAdapter({ ...claude, agent: "some-other-harness" })).toBe(false);
});

test("a session that is not an id is refused", () => {
  // `kind` can name something that is not a session identifier. Only "id" is
  // a value this code knows how to turn into a path.
  expect(hasAdapter({ ...claude, kind: "path" })).toBe(false);
});

test("no session at all is false, never a throw", () => {
  expect(hasAdapter(null)).toBe(false);
  expect(hasAdapter(undefined)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/journal-registry.test.ts`
Expected: FAIL — cannot find module `@server/journal/registry`.

- [ ] **Step 3: Write the types**

Create `src/server/journal/types.ts`:

```ts
/**
 * The journal axis: reading a coding agent's OWN session log.
 *
 * This module tree knows about harnesses (Claude Code, codex, pi) and nothing
 * about herdr. It must never import from `@server/herdr/` — see
 * `docs/architecture.md`. herdr's only contribution is the session id, handed
 * across as a plain string by the caller.
 */

/** One turn, already stripped of everything not being served. */
export interface JournalEntry {
  role: "user" | "assistant";
  /** ISO timestamp as the harness wrote it, or null if the record had none. */
  at: string | null;
  /** Prose only. ANSI removed, menus removed, truncated. */
  text: string;
  /** One-line tool summaries, e.g. "Bash ×3". Never tool OUTPUT. */
  tools: string[];
}

export interface JournalAdapter {
  /** Harness name, matching herdr's `agent_session.agent`. */
  name: string;
  /**
   * The harness version this adapter's record shape was last verified against.
   * A private on-disk format with no compatibility promise, so this is the
   * only honest way to record what "known good" means.
   */
  verifiedAgainst: string;
  /** Absolute path of the session's log, or null when it cannot be found. */
  locate(value: string, roots: readonly string[]): Promise<string | null>;
  /** Parse a raw slice of the log. Unknown records are ignored, never fatal. */
  parse(chunk: string): JournalEntry[];
}

/** Where each harness keeps its logs. A LIST: one machine can hold several. */
export interface JournalRoots {
  claude: readonly string[];
}
```

- [ ] **Step 4: Write the registry**

Create `src/server/journal/registry.ts`:

```ts
import { claudeAdapter } from "@server/journal/claude";
import type { HerdrAgentSession } from "@shared/herdr-api";
import type { JournalAdapter } from "@server/journal/types";

/**
 * The SINGLE decision site for "does this agent have a readable history".
 *
 * Adding a harness is one entry here plus its adapter module — never a new
 * branch in the route and never a condition in the client.
 */
const ADAPTERS: readonly JournalAdapter[] = [claudeAdapter];

export function adapterFor(session: HerdrAgentSession | null | undefined): JournalAdapter | null {
  if (!session) return null;
  // Only an id can become a path. Any other `kind` is a value this code has no
  // way to resolve, and guessing is how a lookup becomes a traversal.
  if (session.kind !== "id") return null;
  return ADAPTERS.find((a) => a.name === session.agent) ?? null;
}

export function hasAdapter(session: HerdrAgentSession | null | undefined): boolean {
  return adapterFor(session) !== null;
}
```

- [ ] **Step 5: Stub the claude adapter so the registry compiles**

Create `src/server/journal/claude.ts` with the minimum this task needs; Task 6 fills it in:

```ts
import type { JournalAdapter } from "@server/journal/types";

export const claudeAdapter: JournalAdapter = {
  name: "claude",
  verifiedAgainst: "unverified",
  async locate() { return null; },
  parse() { return []; },
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/journal-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && make test
git add src/server/journal tests/journal-registry.test.ts
git commit -m "feat: the journal registry — one decision site for readable history"
```

---

### Task 4: safe paths and a bounded tail reader

A session id becomes a filesystem path, so it is hostile input. This task is the containment boundary, and it is worth its own review gate.

**Files:**
- Create: `src/server/journal/files.ts`
- Test: `tests/journal-files.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isSessionId(value: string): boolean`
  - `claudeRoots(env: Record<string, string | undefined>, home: string): string[]`
  - `containedRealpath(root: string, candidate: string): Promise<string | null>`
  - `tailChunk(path: string, endByte: number, maxBytes: number): Promise<{ text: string; startByte: number }>`
  - `MAX_TAIL_BYTES = 512_000`

- [ ] **Step 1: Write the failing tests**

Create `tests/journal-files.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeRoots, containedRealpath, isSessionId, MAX_TAIL_BYTES, tailChunk,
} from "@server/journal/files";

const UUID = "f4971cd4-d53b-430a-8fc6-a0d4572103ae";

test("only a canonical uuid is a session id", () => {
  expect(isSessionId(UUID)).toBe(true);
  expect(isSessionId("../../etc/passwd")).toBe(false);
  expect(isSessionId(`${UUID}/../..`)).toBe(false);
  expect(isSessionId("")).toBe(false);
  expect(isSessionId(`${UUID}.jsonl`)).toBe(false);
});

test("claudeRoots defaults to the home projects dir", () => {
  expect(claudeRoots({}, "/srv/operator")).toEqual(["/srv/operator/.claude/projects"]);
});

test("claudeRoots takes several config dirs, comma-separated and in order", () => {
  // One machine can hold several Claude homes — a per-profile CLAUDE_CONFIG_DIR
  // is the case that forces a list rather than a string.
  expect(claudeRoots({ CLAUDE_CONFIG_DIR: "/a, /b" }, "/srv/operator"))
    .toEqual(["/a/projects", "/b/projects"]);
});

test("containedRealpath accepts a file inside the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  await mkdir(join(root, "proj"));
  const file = join(root, "proj", `${UUID}.jsonl`);
  await writeFile(file, "{}\n");
  expect(await containedRealpath(root, file)).toBe(file);
});

test("containedRealpath refuses a path that escapes via ..", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  expect(await containedRealpath(root, join(root, "..", "escape.jsonl"))).toBeNull();
});

test("containedRealpath refuses a symlink pointing outside the root", async () => {
  // The check is on the RESOLVED path, not the requested one: a symlink inside
  // the root is the way a string that looks contained stops being contained.
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  const outside = await mkdtemp(join(tmpdir(), "paddock-out-"));
  const target = join(outside, "secrets.jsonl");
  await writeFile(target, "{}\n");
  const link = join(root, `${UUID}.jsonl`);
  await symlink(target, link);
  expect(await containedRealpath(root, link)).toBeNull();
});

test("containedRealpath returns null for a file that does not exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  expect(await containedRealpath(root, join(root, `${UUID}.jsonl`))).toBeNull();
});

test("tailChunk reads from the END and reports where it started", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  const file = join(root, "big.jsonl");
  const body = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
  await writeFile(file, body);
  const { text, startByte } = await tailChunk(file, body.length, 40);
  expect(text.endsWith("line-99")).toBe(true);
  expect(startByte).toBe(body.length - 40);
  expect(text.length).toBe(40);
});

test("tailChunk never reads before the start of the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  const file = join(root, "small.jsonl");
  await writeFile(file, "abc");
  const { text, startByte } = await tailChunk(file, 3, 999);
  expect(text).toBe("abc");
  expect(startByte).toBe(0);
});

test("the tail cap is bounded, so one request cannot read a whole huge log", () => {
  // Measured: a real session is 1.5 MB / 729 records, ~2 KB per record. This
  // cap is ~250 records' worth per request, well above one page of history.
  expect(MAX_TAIL_BYTES).toBe(512_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/journal-files.test.ts`
Expected: FAIL — cannot find module `@server/journal/files`.

- [ ] **Step 3: Implement**

Create `src/server/journal/files.ts`:

```ts
import { realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Bytes one request may read from a journal.
 *
 * Measured on a real session: 1.5 MB across 729 records, ~2 KB per record. So
 * this is ~250 records per request — far more than one page of "show earlier",
 * and far less than a whole log. A cap on the REQUEST, not on the file: paging
 * backwards still reaches the beginning, one bounded read at a time.
 */
export const MAX_TAIL_BYTES = 512_000;

/** A session id as the harness writes it: canonical 8-4-4-4-12 hex. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value may be turned into a path AT ALL.
 *
 * Anchored on both ends and checked BEFORE any filesystem call. This is the
 * cheap half of containment: nothing with a separator, a dot segment, or an
 * extension ever reaches `realpath`.
 */
export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/**
 * Claude Code's project roots, in search order.
 *
 * A LIST because `CLAUDE_CONFIG_DIR` is per-profile and one machine can hold
 * several Claude homes. Comma-separated, trimmed, empties dropped.
 */
export function claudeRoots(env: Record<string, string | undefined>, home: string): string[] {
  const configured = (env.CLAUDE_CONFIG_DIR ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const dirs = configured.length > 0 ? configured : [join(home, ".claude")];
  return dirs.map((d) => join(d, "projects"));
}

/**
 * The resolved path, if and only if it really sits inside `root`.
 *
 * Resolved with `realpath`, never compared as strings: a symlink inside the
 * root is exactly how a path that LOOKS contained stops being contained, and a
 * journal root is a directory the operator's tools write into freely.
 *
 * Returns null rather than throwing for a missing file — "no journal here" is
 * an ordinary answer this feature reports as a fallback, not an exception.
 */
export async function containedRealpath(root: string, candidate: string): Promise<string | null> {
  let real: string;
  let realRoot: string;
  try {
    real = await realpath(resolve(candidate));
    realRoot = await realpath(resolve(root));
  } catch {
    return null;
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return real.startsWith(prefix) ? real : null;
}

/**
 * The last `maxBytes` of the file ending at `endByte`, and where that slice
 * began.
 *
 * Reads BACKWARDS from a byte offset rather than loading the file: paging is
 * the whole reason the route is cursored, and a 1.5 MB read per "show earlier"
 * tap on a phone is the cost this avoids. `startByte` is what the caller
 * returns as the next cursor.
 */
export async function tailChunk(
  path: string,
  endByte: number,
  maxBytes: number,
): Promise<{ text: string; startByte: number }> {
  const capped = Math.min(maxBytes, MAX_TAIL_BYTES);
  const startByte = Math.max(0, endByte - capped);
  const text = await Bun.file(path).slice(startByte, endByte).text();
  return { text, startByte };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/journal-files.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Mutation-check the containment guard (house rule 4)**

Temporarily change `containedRealpath`'s last line to `return real;` and re-run.
Expected: the `..` and symlink tests go RED. Restore, confirm green again. Do the same for `isSessionId` by making it `return true` — the traversal tests must go red.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add src/server/journal/files.ts tests/journal-files.test.ts
git commit -m "feat: journal path containment and a bounded tail reader"
```

---

### Task 5: text shaping — what is served and what is never served

The exposure decision lives here: prose is kept, tool output is dropped, and menus are stripped so a stale prompt cannot read as the live one.

**Files:**
- Create: `src/server/journal/text.ts`
- Test: `tests/journal-text.test.ts`

**Interfaces:**
- Consumes: `JournalEntry` (Task 3).
- Produces:
  - `stripAnsi(text: string): string`
  - `stripMenu(text: string): string`
  - `summariseTool(name: string, input: unknown): string`
  - `clamp(text: string, max: number): string`
  - `toLines(entries: readonly JournalEntry[]): string[]`
  - `MAX_TEXT_CHARS = 4_000`

- [ ] **Step 1: Write the failing tests**

Create `tests/journal-text.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  clamp, MAX_TEXT_CHARS, stripAnsi, stripMenu, summariseTool, toLines,
} from "@server/journal/text";

test("ansi escapes are removed", () => {
  expect(stripAnsi("[1;36mhello[0m")).toBe("hello");
});

test("a cursor marker is stripped from journal text", () => {
  // THE hazard. A journal turn can carry an ALREADY ANSWERED menu, and blended
  // straight above the live screen it reads as the question being asked now.
  // `prompt-parse.ts` records this exact failure. Only the live screen may
  // render a selectable menu.
  expect(stripMenu("❯ 1. Yes")).toBe("");
  expect(stripMenu("  ❯ 2. No, keep it")).toBe("");
});

test("a numbered option row is stripped even without a cursor", () => {
  expect(stripMenu("  2. No")).toBe("");
  expect(stripMenu("1. Approve this change")).toBe("");
});

test("ordinary prose that merely starts with a number survives", () => {
  // Over-stripping would silently eat real content, which is worse than the
  // hazard it guards: "2. " here is prose the agent wrote, not an option row.
  expect(stripMenu("2026 was the year")).toBe("2026 was the year");
  expect(stripMenu("I found 3 failures")).toBe("I found 3 failures");
});

test("a tool call becomes a name and a short hint, never its output", () => {
  expect(summariseTool("Bash", { command: "bun test", description: "run tests" }))
    .toBe("Bash · run tests");
  expect(summariseTool("Read", { file_path: "/srv/project/src/timer.ts" }))
    .toBe("Read · timer.ts");
  expect(summariseTool("Write", {})).toBe("Write");
});

test("a tool hint never carries a whole command line", () => {
  // The hint is orientation, not a transcript. An unbounded command would put
  // arbitrary shell text — and anything interpolated into it — on the wire.
  const long = "x".repeat(500);
  expect(summariseTool("Bash", { description: long }).length).toBeLessThanOrEqual(80);
});

test("clamp truncates to AT MOST max characters, ellipsis included", () => {
  // The ellipsis counts. A clamp that returns max+1 makes every caller's cap
  // a lie by one character, which is how `summariseTool` would exceed its own.
  expect(clamp("abcdef", 3)).toBe("ab…");
  expect(clamp("abcdef", 3).length).toBe(3);
  expect(clamp("abc", 10)).toBe("abc");
});

test("toLines renders a turn with a speaker and folds its tools", () => {
  const lines = toLines([
    { role: "user", at: "2026-08-20T13:04:00Z", text: "fix the flaky test", tools: [] },
    { role: "assistant", at: "2026-08-20T13:05:00Z", text: "Found it: the timer resets.", tools: ["Bash ×3", "Read timer.ts"] },
  ]);
  expect(lines).toEqual([
    "you · 13:04",
    "fix the flaky test",
    "",
    "agent · 13:05",
    "▸ Bash ×3 · Read timer.ts",
    "Found it: the timer resets.",
    "",
  ]);
});

test("toLines drops a turn left empty by stripping", () => {
  // A turn that was only a menu must not leave a bare speaker line behind.
  expect(toLines([{ role: "assistant", at: null, text: "", tools: [] }])).toEqual([]);
});

test("the text cap is bounded", () => {
  expect(MAX_TEXT_CHARS).toBe(4_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/journal-text.test.ts`
Expected: FAIL — cannot find module `@server/journal/text`.

- [ ] **Step 3: Implement**

Create `src/server/journal/text.ts`:

```ts
import type { JournalEntry } from "@server/journal/types";

/** Ceiling on one turn's prose. Generous for a message, bounded on the wire. */
export const MAX_TEXT_CHARS = 4_000;

/** Ceiling on a tool summary line. Orientation, never a transcript. */
const MAX_TOOL_HINT = 80;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]|[()][A-Za-z0-9]|./g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * A cursor-marked row, e.g. `❯ 1. Yes`, or a bare numbered option row.
 *
 * Requires the row to be ONLY the option — anchored both ends, short label —
 * so ordinary prose that happens to open with a number survives. Over-stripping
 * silently eats real content, which is a worse failure than the one this
 * guards.
 */
const MENU_RE = /^\s*(?:❯\s*)?\d{1,2}\.\s+\S[^\n]{0,60}$/;
const CURSOR_ONLY_RE = /^\s*❯\s*\S[^\n]{0,60}$/;

/**
 * Remove an option row from journal text, leaving "" if that is all it was.
 *
 * WHY: journal lines are blended directly above the live screen with no
 * divider (design decision 3). A menu from an already-answered question would
 * then read as the live prompt — the failure `prompt-parse.ts` already records
 * in its own scoping comment. Only the live screen may show a selectable menu.
 */
export function stripMenu(text: string): string {
  if (MENU_RE.test(text) || CURSOR_ONLY_RE.test(text)) return "";
  return text;
}

/**
 * Truncate to AT MOST `max` characters, ellipsis included, so a cut is never
 * mistaken for the end and a caller's cap is never off by one.
 */
export function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * One line for a tool call: its name, and a short hint at what it touched.
 *
 * Never its RESULT. Tool results are where file contents, command output and
 * any secret that passed through the agent live, and design decision 4 keeps
 * them off the wire entirely.
 */
export function summariseTool(name: string, input: unknown): string {
  const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const raw =
    typeof obj.description === "string" ? obj.description
    : typeof obj.file_path === "string" ? obj.file_path.split("/").pop() ?? ""
    : typeof obj.pattern === "string" ? obj.pattern
    : "";
  const hint = stripAnsi(raw).replace(/\s+/g, " ").trim();
  // Clamped on the FINISHED line, not on the hint, so the cap holds whatever
  // the tool name's length happens to be.
  return clamp(hint === "" ? name : `${name} · ${hint}`, MAX_TOOL_HINT);
}

/** `13:04` from an ISO stamp, or "" when the record carried none. */
function hhmm(at: string | null): string {
  if (at === null) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? ""
    : `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Flatten turns to the lines the terminal renders.
 *
 * Server-side, because the client must gain no per-harness knowledge — the same
 * reason `parsePrompt` lives on this side of the socket.
 */
export function toLines(entries: readonly JournalEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const body = clamp(stripMenu(stripAnsi(e.text)).trim(), MAX_TEXT_CHARS);
    if (body === "" && e.tools.length === 0) continue;
    const who = e.role === "user" ? "you" : "agent";
    const time = hhmm(e.at);
    out.push(time === "" ? who : `${who} · ${time}`);
    if (e.tools.length > 0) out.push(`▸ ${e.tools.join(" · ")}`);
    if (body !== "") out.push(...body.split("\n"));
    out.push("");
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/journal-text.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Mutation-check the menu guard (house rule 4)**

Make `stripMenu` `return text;` and re-run.
Expected: the two menu tests go RED. Restore and confirm green.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add src/server/journal/text.ts tests/journal-text.test.ts
git commit -m "feat: journal text shaping — prose kept, tool output and menus never served"
```

---

### Task 6: the Claude adapter

**Files:**
- Modify: `src/server/journal/claude.ts` (replacing Task 3's stub)
- Create: `tests/fixtures/journal/claude-session.jsonl`
- Test: `tests/journal-claude.test.ts`

**Interfaces:**
- Consumes: `JournalAdapter`, `JournalEntry` (Task 3); `isSessionId`, `containedRealpath` (Task 4); `summariseTool` (Task 5).
- Produces: `claudeAdapter: JournalAdapter` with a real `locate` and `parse`.

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/journal/claude-session.jsonl` — invented content only, per house rule 2:

```jsonl
{"type":"user","timestamp":"2026-08-20T13:04:00Z","message":{"role":"user","content":"fix the flaky test"}}
{"type":"assistant","timestamp":"2026-08-20T13:04:30Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private reasoning that must not be served"},{"type":"text","text":"Looking at the timer now."},{"type":"tool_use","name":"Bash","input":{"command":"bun test","description":"run tests"}}]}}
{"type":"user","timestamp":"2026-08-20T13:04:31Z","message":{"role":"user","content":[{"type":"tool_result","content":"SECRET_TOKEN=abc123 leaked in output"}]}}
{"type":"assistant","timestamp":"2026-08-20T13:05:00Z","message":{"role":"assistant","content":[{"type":"text","text":"Found it: the timer resets."}]}}
{"type":"assistant","timestamp":"2026-08-20T13:05:10Z","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent chatter"}]}}
{"type":"mode","timestamp":"2026-08-20T13:05:20Z","mode":"default"}
not valid json at all
{"type":"assistant","timestamp":"2026-08-20T13:06:00Z","message":{"role":"assistant","content":[{"type":"text","text":"❯ 1. Yes"}]}}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/journal-claude.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeAdapter } from "@server/journal/claude";

const chunk = readFileSync("tests/fixtures/journal/claude-session.jsonl", "utf8");
const entries = claudeAdapter.parse(chunk);

test("a typed user message becomes a user turn", () => {
  expect(entries[0]).toEqual({
    role: "user", at: "2026-08-20T13:04:00Z", text: "fix the flaky test", tools: [],
  });
});

test("assistant text and its tool call arrive as one turn", () => {
  expect(entries[1]!.role).toBe("assistant");
  expect(entries[1]!.text).toBe("Looking at the timer now.");
  expect(entries[1]!.tools).toEqual(["Bash · run tests"]);
});

test("a tool RESULT is never served", () => {
  // This is where file contents, command output and secrets live. Asserted on
  // the whole parse, because one leak anywhere is the whole failure.
  expect(JSON.stringify(entries)).not.toContain("SECRET_TOKEN");
});

test("a user record whose content is a LIST is not a typed message", () => {
  // Folding these is what stops a session rendering hundreds of fabricated
  // "you" turns: tool-result traffic is written as role user.
  expect(entries.filter((e) => e.role === "user")).toHaveLength(1);
});

test("thinking blocks are dropped", () => {
  expect(JSON.stringify(entries)).not.toContain("private reasoning");
});

test("subagent traffic is dropped", () => {
  expect(JSON.stringify(entries)).not.toContain("subagent chatter");
});

test("bookkeeping records are ignored, not turned into turns", () => {
  expect(entries.every((e) => e.text !== "default")).toBe(true);
});

test("one unparseable line is skipped without losing the file", () => {
  // The record AFTER the broken line must still be present: a private format
  // will grow rows this parser has never seen, and one of them must not cost
  // the operator their whole history.
  expect(entries.at(-1)!.text).toBe("❯ 1. Yes");
});

test("the adapter records the harness version its shape was verified against", () => {
  expect(claudeAdapter.verifiedAgainst).not.toBe("unverified");
});

test("locate refuses a value that is not a session id, before touching disk", async () => {
  expect(await claudeAdapter.locate("../../etc/passwd", ["/nonexistent"])).toBeNull();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/journal-claude.test.ts`
Expected: FAIL — the stub returns `[]`, so `entries[0]` is undefined.

- [ ] **Step 4: Implement**

Replace `src/server/journal/claude.ts` entirely:

```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { containedRealpath, isSessionId } from "@server/journal/files";
import { summariseTool } from "@server/journal/text";
import type { JournalAdapter, JournalEntry } from "@server/journal/types";

/**
 * Claude Code's journal adapter.
 *
 * WHY THIS EXISTS. A pane running Claude sits on the terminal's ALTERNATE
 * SCREEN, which has no scrollback ring, so `pane.read` can never return more
 * than the viewport however much is asked for — see
 * `docs/design/2026-08-20-journal-history-design.md` for the measurements. The
 * history does exist, in Claude Code's own session log, and herdr hands us its
 * uuid on `agent_session`.
 *
 * SHAPE OF THE SOURCE. This is a PRIVATE on-disk format with no compatibility
 * promise; it will change without notice. Every unknown record type is ignored
 * rather than fatal, and one unparseable line is skipped rather than costing
 * the file. `verifiedAgainst` records when the shape was last checked by hand —
 * update it whenever you re-check, the way `docs/gotchas.md` treats every other
 * measured claim in this repo.
 *
 *   {"type":"user",      "message":{"role":"user","content":"…" | [ {type:"tool_result"} ]}}
 *   {"type":"assistant", "message":{"role":"assistant","content":[ {type:"text"|"thinking"|"tool_use"} ]}}
 *
 * A `user` record whose content is a LIST is tool-result traffic, not something
 * a person typed. `isSidechain` marks subagent traffic.
 */
export const claudeAdapter: JournalAdapter = {
  name: "claude",
  verifiedAgainst: "Claude Code 2.1.220, checked 2026-08-20",

  async locate(value, roots) {
    // Checked before any filesystem call — see files.ts.
    if (!isSessionId(value)) return null;
    for (const root of roots) {
      let projects: string[];
      try {
        projects = await readdir(root);
      } catch {
        continue; // a root that does not exist is not an error, it is a miss
      }
      for (const project of projects) {
        const found = await containedRealpath(root, join(root, project, `${value}.jsonl`));
        if (found !== null) return found;
      }
    }
    return null;
  },

  parse(chunk) {
    const out: JournalEntry[] = [];
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A partial first line is NORMAL: a tail read starts mid-record. A
        // genuinely corrupt line costs itself and nothing else.
        continue;
      }
      const entry = toEntry(rec);
      if (entry !== null) out.push(entry);
    }
    return out;
  },
};

function toEntry(rec: Record<string, unknown>): JournalEntry | null {
  const type = rec.type;
  if (type !== "user" && type !== "assistant") return null; // bookkeeping rows
  if (rec.isSidechain === true) return null; // subagent traffic

  const at = typeof rec.timestamp === "string" ? rec.timestamp : null;
  const message = rec.message as { content?: unknown } | undefined;
  const content = message?.content;

  if (type === "user") {
    // A STRING is a person typing. A LIST is tool-result traffic wearing the
    // user role, and rendering those would fabricate hundreds of "you" turns.
    if (typeof content !== "string" || content.trim() === "") return null;
    return { role: "user", at, text: content, tools: [] };
  }

  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  const tools: string[] = [];
  for (const part of content) {
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
    else if (p.type === "tool_use" && typeof p.name === "string") {
      tools.push(summariseTool(p.name, p.input));
    }
    // "thinking" and everything unknown falls through deliberately.
  }
  if (texts.length === 0 && tools.length === 0) return null;
  return { role: "assistant", at, text: texts.join("\n"), tools };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/journal-claude.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Mutation-check the exposure guard (house rule 4)**

In `toEntry`, change the `user` branch to accept a list as well (`if (Array.isArray(content)) return { role: "user", at, text: JSON.stringify(content), tools: [] }`).
Expected: the `SECRET_TOKEN` and "list is not a typed message" tests go RED. Restore and confirm green.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && make test
git add src/server/journal/claude.ts tests/journal-claude.test.ts tests/fixtures/journal
git commit -m "feat: the Claude Code journal adapter"
```

---

### Task 7: the history route

**Files:**
- Create: `src/server/journal/read.ts`
- Modify: `src/server/routes.ts` (`AppDeps`, and a new route registered unconditionally)
- Modify: `src/server/index.ts` (wire the journal reader and the `hasJournal` predicate)
- Modify: `src/server/supervisor.ts:257` (pass `hasJournal`, capture `sessionRefs`)
- Test: `tests/journal-route.test.ts`

**Interfaces:**
- Consumes: `adapterFor` (Task 3), `claudeRoots`/`tailChunk`/`MAX_TAIL_BYTES` (Task 4), `toLines` (Task 5), `claudeAdapter` (Task 6), `sessionRefs` (Task 2).
- Produces:
  - `interface JournalReader { read(session: HerdrAgentSession | null | undefined, before: number | null, limit: number): Promise<JournalPage> }`
  - `interface JournalPage { lines: string[]; source: "journal" | "reconstruction"; hasMore: boolean; cursor: string | null; detail: string | null }`
  - `createJournalReader(roots: JournalRoots): JournalReader`
  - `AppDeps.journal?: JournalReader`
  - `AppDeps.sessionFor?: (agentId: string) => HerdrAgentSession | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/journal-route.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;
const health = () => ({
  ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true,
  lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null,
  herdrProtocol: null, schemaWarning: null,
});

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "docs-cleanup",
    task: "Tidy the README", state: "working", workspaceId: "w1",
    workspaceLabel: "docs", cwd: "/srv/project", stateSince: NOW, updatedAt: NOW,
    acknowledgedAt: null, hasJournal: true, ...over,
  };
}

function harness(page = { lines: ["you · 13:04", "hi", ""], source: "journal" as const, hasMore: true, cursor: "120", detail: null }) {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const calls: unknown[] = [];
  const app = createApp({
    store, now: () => NOW, health, hub: new Hub({ now: () => NOW }),
    sessionFor: () => ({ agent: "claude", kind: "id", source: "herdr:claude", value: "u1" }),
    journal: { async read(_s, before, limit) { calls.push({ before, limit }); return page; } },
  });
  return { app, calls };
}

const post = (app: ReturnType<typeof createApp>, body: object) =>
  app.request("/api/agents/w1:p1/history", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });

test("returns lines, provenance and a cursor", async () => {
  const { app } = harness();
  const res = await post(app, {});
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.lines).toEqual(["you · 13:04", "hi", ""]);
  expect(body.source).toBe("journal");
  expect(body.hasMore).toBe(true);
  expect(body.cursor).toBe("120");
});

test("the cursor is passed through as a number", async () => {
  const { app, calls } = harness();
  await post(app, { before: "120", limit: 25 });
  expect(calls[0]).toEqual({ before: 120, limit: 25 });
});

test("a non-numeric cursor is refused rather than coerced", async () => {
  // The cursor is opaque to the client and MUST be one this server issued.
  // Coercing garbage to 0 would silently serve the top of the file instead.
  const { app } = harness();
  expect((await post(app, { before: "../etc" })).status).toBe(400);
});

test("an unknown agent is 404, not an empty page", async () => {
  const { app } = harness();
  const res = await app.request("/api/agents/nope/history", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: "{}",
  });
  expect(res.status).toBe(404);
});

test("no journal reports reconstruction with a reason, and 200", async () => {
  // The UI falls back quietly, so this is a normal answer rather than an error
  // — but the reason still travels, because nothing may be swallowed.
  const { app } = harness({
    lines: [], source: "reconstruction", hasMore: false, cursor: null,
    detail: "no journal adapter for this harness",
  });
  const res = await post(app, {});
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.source).toBe("reconstruction");
  expect(body.lines).toEqual([]);
  expect(body.detail).toContain("no journal");
});

test("the route exists with no actions dep — it never touches herdr", async () => {
  // Registered unconditionally, unlike the action routes. Gating a
  // filesystem read on a herdr dependency is the /ack mistake: the one
  // feature that works without herdr being the one broken in --demo.
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app = createApp({
    store, now: () => NOW, health, hub: new Hub({ now: () => NOW }),
    sessionFor: () => null,
    journal: { async read() { return { lines: [], source: "reconstruction" as const, hasMore: false, cursor: null, detail: "no session" }; } },
  });
  expect((await post(app, {})).status).toBe(200);
});

test("the same-origin gate covers it like any other POST", async () => {
  const { app } = harness();
  const res = await app.request("/api/agents/w1:p1/history", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: "{}",
  });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/journal-route.test.ts`
Expected: FAIL — `sessionFor`/`journal` are not on `AppDeps`; the route 404s.

- [ ] **Step 3: Write the reader**

Create `src/server/journal/read.ts`:

```ts
import { adapterFor } from "@server/journal/registry";
import { claudeRoots, MAX_TAIL_BYTES, tailChunk } from "@server/journal/files";
import { toLines } from "@server/journal/text";
import type { JournalRoots } from "@server/journal/types";
import type { HerdrAgentSession } from "@shared/herdr-api";

export interface JournalPage {
  lines: string[];
  /**
   * `"reconstruction"` is the server saying "I have no journal for this
   * agent" — it always comes with `lines: []` and a `detail`. Reconstruction
   * itself is entirely client-side. This field is a ROUTING answer, not a
   * description of the payload.
   */
  source: "journal" | "reconstruction";
  hasMore: boolean;
  /** Opaque to the client: a byte offset it echoes back, never constructs. */
  cursor: string | null;
  detail: string | null;
}

export interface JournalReader {
  read(
    session: HerdrAgentSession | null | undefined,
    before: number | null,
    limit: number,
  ): Promise<JournalPage>;
}

const none = (detail: string): JournalPage => ({
  lines: [], source: "reconstruction", hasMore: false, cursor: null, detail,
});

export function createJournalReader(roots: JournalRoots): JournalReader {
  return {
    async read(session, before, limit) {
      const adapter = adapterFor(session);
      if (adapter === null || !session) return none("no journal adapter for this harness");

      const path = await adapter.locate(session.value, roots.claude);
      if (path === null) return none("session log not found — compacted, rotated or removed");

      let size: number;
      try {
        size = Bun.file(path).size;
      } catch (err) {
        return none(`could not read the session log: ${String(err)}`);
      }

      const end = before ?? size;
      if (end <= 0) return { lines: [], source: "journal", hasMore: false, cursor: null, detail: null };

      const { text, startByte } = await tailChunk(path, end, MAX_TAIL_BYTES);
      // The first line of a tail read is usually a PARTIAL record. Dropping it
      // is correct rather than lossy: the next page, which starts earlier,
      // contains it whole.
      const usable = startByte > 0 ? text.slice(text.indexOf("\n") + 1) : text;
      const entries = adapter.parse(usable).slice(-limit);
      return {
        lines: toLines(entries),
        source: "journal",
        hasMore: startByte > 0,
        cursor: startByte > 0 ? String(startByte) : null,
        detail: null,
      };
    },
  };
}

/** Roots for the harnesses paddock reads, from the real environment. */
export function defaultRoots(env: Record<string, string | undefined>, home: string): JournalRoots {
  return { claude: claudeRoots(env, home) };
}
```

- [ ] **Step 4: Add the route**

In `src/server/routes.ts`, add to `AppDeps` after `settings?`:

```ts
  /** Reads a harness's own session log. Omit in tests that do not exercise it. */
  journal?: JournalReader;
  /** The server-side session id for an agent. Never crosses the socket. */
  sessionFor?: (agentId: string) => HerdrAgentSession | null;
```

Import them: `import type { JournalReader } from "@server/journal/read";` and add `HerdrAgentSession` to the `@shared/herdr-api` import.

Register the route immediately after the `/api/agents/:id/ack` route — **outside** the `deps.actions` block:

```ts
    /**
     * Earlier history from the agent's OWN session log.
     *
     * Registered unconditionally, like `/ack` and unlike the action routes:
     * this reads a file and never touches herdr, so gating it on a herdr
     * dependency it does not use would repeat the mistake `/ack`'s comment
     * records — the one feature that works without herdr being the one
     * visibly broken in `--demo`.
     *
     * POST, not GET: a cursor in a query string lands in edge access logs.
     */
    app.post("/api/agents/:id/history", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      if (!deps.journal) return c.json({ ok: false, detail: "journal reading is not configured" }, 404);

      const body = await jsonBody(c);
      // Refused, never coerced: the cursor is opaque and must be one this
      // server issued. Folding garbage to 0 would silently serve the top of
      // the file instead of the page the operator asked for.
      let before: number | null = null;
      if (body.before !== undefined && body.before !== null) {
        if (typeof body.before !== "string" || !/^\d+$/.test(body.before)) {
          return c.json({ ok: false, detail: "before must be a cursor from a previous response" }, 400);
        }
        before = Number(body.before);
      }
      const limit = typeof body.limit === "number" && body.limit > 0 && body.limit <= 200
        ? Math.floor(body.limit)
        : 50;

      const page = await deps.journal.read(deps.sessionFor?.(agent.agentId) ?? null, before, limit);
      if (page.detail !== null) reportJournalMiss(agent.agentId, page.detail);
      return c.json({ ok: true, ...page });
    });
```

Add beside `reportRefusal`:

```ts
/**
 * A journal that could not be read is quiet in the UI and loud here.
 *
 * The operator sees the old behaviour — falling back to reconstruction is a
 * working dashboard, and a banner for a pane that never had a journal would be
 * noise. The host does not get to be quiet: `CLAUDE.md` forbids swallowing
 * errors, and "history silently stopped going deeper" is otherwise invisible.
 * Once per agent, because it is reported on every page request.
 */
const journalMissesSeen = new Set<string>();

function reportJournalMiss(agentId: string, detail: string): void {
  if (journalMissesSeen.has(agentId)) return;
  journalMissesSeen.add(agentId);
  warn(`paddock: no journal history for \`${agentId}\` — ${detail}`);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/journal-route.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Wire it in the composition root**

In `src/server/supervisor.ts`, capture the refs and inject the predicate. Replace the `toAgents` call at line 257:

```ts
    const agents = toAgents(list.agents ?? [], {
      hostId: this.opts.store.hostId,
      labels: this.labels,
      now,
      hasJournal: hasAdapter,
    });
    // Server-side only: the ids these hold are filesystem keys and must not
    // travel with the agent. Replaced wholesale each reconcile, so a closed
    // pane's id does not linger.
    this.sessions = sessionRefs(list.agents ?? []);
```

Add the field and accessor to the `Supervisor` class:

```ts
  private sessions = new Map<string, HerdrAgentSession>();

  sessionFor(agentId: string): HerdrAgentSession | null {
    return this.sessions.get(agentId) ?? null;
  }
```

Update its imports: `sessionRefs` from `@server/herdr/adapter`, `hasAdapter` from `@server/journal/registry`, and the `HerdrAgentSession` type.

In `src/server/index.ts`, add to `appDeps`:

```ts
  journal: createJournalReader(defaultRoots(process.env, homedir())),
  sessionFor: (id: string) => supervisor?.sessionFor(id) ?? null,
```

with `import { homedir } from "node:os";` and `import { createJournalReader, defaultRoots } from "@server/journal/read";`.

- [ ] **Step 7: Verify against a live herdr**

Run `paddock` where herdr is running, open an agent, and check the route directly:

```bash
curl -s -X POST -H 'content-type: application/json' -H 'Origin: http://127.0.0.1:8787' \
  -d '{"limit":5}' http://127.0.0.1:8787/api/agents/<pane-id>/history | head -20
```

Expected: `"source":"journal"` and real lines for a Claude pane; `"source":"reconstruction"` with a `detail` for a plain shell pane. Put the observed result in the commit message — house rule 3.

- [ ] **Step 8: Commit**

```bash
make check && make check-clean && make test
git add -A
git commit -m "feat: POST /api/agents/:id/history, served from the agent's own log"
```

---

### Task 8: the terminal view uses it

**Files:**
- Modify: `src/web/api.ts` (new client call)
- Modify: `src/web/components/AgentTerminal.tsx` (the "Show earlier" handler and its label, around lines 461 and 565)
- Modify: `docs/decisions.md`, `docs/architecture.md`, `docs/gotchas.md`, `docs/roadmap.md`
- Test: `tests/journal-terminal.test.tsx`

**Interfaces:**
- Consumes: the route from Task 7; `Agent.hasJournal` from Task 2.
- Produces: `fetchHistory(agentId: string, before: string | null, limit?: number): Promise<{ lines: string[]; source: string; hasMore: boolean; cursor: string | null }>` in `src/web/api.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/journal-terminal.test.tsx`, following the existing pattern in `tests/terminal-render.test.tsx` (import `tests/support/dom.ts` first, use `render`/`settle` from `tests/support/render.tsx`, and `stubFetch`):

```tsx
test("an agent with a journal fetches earlier lines instead of reading the cache", async () => {
  const fetched: string[] = [];
  stubFetch((url) => {
    fetched.push(url);
    return { ok: true, lines: ["you · 13:04", "fix the flaky test", ""], source: "journal", hasMore: false, cursor: null, detail: null };
  });
  const el = render(<AgentTerminal agent={agent({ hasJournal: true })} onClose={() => {}} />);
  await settle();
  click(el.querySelector(".term-earlier")!);
  await settle();
  expect(fetched.some((u) => u.endsWith("/history"))).toBe(true);
  expect(el.textContent).toContain("fix the flaky test");
});

test("an agent with no journal never calls the route", async () => {
  // Nothing regresses for a plain shell pane: it keeps the client-side
  // reconstruction it has today.
  const fetched: string[] = [];
  stubFetch((url) => { fetched.push(url); return { ok: true, lines: [], source: "visible" }; });
  const el = render(<AgentTerminal agent={agent({ hasJournal: false })} onClose={() => {}} />);
  await settle();
  const earlier = el.querySelector(".term-earlier");
  if (earlier) click(earlier);
  await settle();
  expect(fetched.some((u) => u.endsWith("/history"))).toBe(false);
});

test("a journal line carrying a menu cannot render as a live option", async () => {
  // Belt and braces over the server's stripMenu: the blend has no divider, so
  // a stale "❯ 1. Yes" above the live screen would read as the live prompt.
  stubFetch(() => ({ ok: true, lines: ["agent · 13:06", "❯ 1. Yes", ""], source: "journal", hasMore: false, cursor: null, detail: null }));
  const el = render(<AgentTerminal agent={agent({ hasJournal: true })} onClose={() => {}} />);
  await settle();
  click(el.querySelector(".term-earlier")!);
  await settle();
  expect(el.querySelectorAll("button.term-option")).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/journal-terminal.test.tsx`
Expected: FAIL — the component never requests `/history`.

- [ ] **Step 3: Add the client call**

In `src/web/api.ts`, beside the other POST helpers:

```ts
/**
 * Earlier history from the agent's own session log.
 *
 * `before` is OPAQUE — echo back what the last response gave and never build
 * one. `source` says which history the server actually had; `"reconstruction"`
 * means "use your local one", and arrives with no lines.
 */
export async function fetchHistory(
  agentId: string,
  before: string | null,
  limit = 50,
): Promise<{ lines: string[]; source: string; hasMore: boolean; cursor: string | null }> {
  const res = await post(`/api/agents/${encodeURIComponent(agentId)}/history`, { before, limit });
  return res as { lines: string[]; source: string; hasMore: boolean; cursor: string | null };
}
```

Match the file's existing `post` helper and error handling rather than inventing a second style.

- [ ] **Step 4: Use it in the terminal**

In `AgentTerminal.tsx`, add state beside `shownHistory`:

```tsx
  // Journal-sourced lines, oldest first, and the cursor for the next page.
  // Kept separate from `history.settled` because the two sources never mix for
  // one agent (design decision 2) — this is which one is in play, not a merge.
  const [journalLines, setJournalLines] = useState<string[]>([]);
  const [journalCursor, setJournalCursor] = useState<string | null>(null);
  const [journalDone, setJournalDone] = useState(false);
```

Replace the `revealed` computation:

```tsx
  const revealed = agent.hasJournal
    ? journalLines
    : shownHistory > 0
      ? history.settled.slice(Math.max(0, history.settled.length - shownHistory))
      : [];
```

Replace the "Show earlier" button's condition and handler:

```tsx
      {!error && (agent.hasJournal ? !journalDone : history.settled.length > revealed.length) && (
        <button
          type="button"
          className="term-earlier"
          onClick={() => {
            const el = paneRef.current;
            const before = el ? el.scrollHeight - el.scrollTop : 0;
            const restore = () => requestAnimationFrame(() => {
              if (el) el.scrollTop = el.scrollHeight - before;
            });
            if (!agent.hasJournal) {
              setShownHistory((n) => n + HISTORY_PAGE);
              restore();
              return;
            }
            void fetchHistory(agent.agentId, journalCursor).then((page) => {
              // PREPEND: a page fetched with a cursor is older than what is held.
              setJournalLines((held) => [...page.lines, ...held]);
              setJournalCursor(page.cursor);
              if (!page.hasMore || page.source !== "journal") setJournalDone(true);
              restore();
            }).catch(() => setJournalDone(true));
          }}
        >
          Show earlier
          {!agent.hasJournal && ` · ${history.settled.length - revealed.length} lines`}
          {!agent.hasJournal && history.gaps > 0 && (
            <span className="term-gapnote"> · {history.gaps} gaps</span>
          )}
        </button>
      )}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/journal-terminal.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the documentation**

`docs/decisions.md` — append decision 18 covering the six decisions in the design doc's "Decisions" section, in the same voice as decisions 12 and 17: what was chosen, what was rejected, and why. State plainly that journal lines are prose and will not look like the live screen, and that menus are stripped because a stale prompt blended above the screen would read as the live one.

`docs/architecture.md` — add `journal/` to the dependency description as a new axis beside `herdr/`, noting it knows harnesses rather than herdr and that `adapter.ts` receives its predicate by injection rather than importing it.

`docs/gotchas.md` — add, under the herdr section:

```markdown
- **A coding agent's pane has no scrollback to read, at any price.** It runs on
  the terminal's alternate screen, which keeps nothing behind the viewport:
  every such pane reports `scroll.max_offset_from_bottom: 0`. Measured against
  herdr 0.8.0, asking anyway costs ~35 ms per line past the viewport — 300 lines
  10.7 s (past `HERDR_TIMEOUT_MS`), and 500/1000/2000 lines each ~15.8 s while
  returning LESS than `visible` returns in 2 ms. The bytes were never retained.
  This is why history comes from the harness's own log — see
  `src/server/journal/`.
```

`docs/roadmap.md` — mark the `MAX_READ_LINES` entry resolved by this work, in the same struck-through-with-explanation style the file already uses. Do not delete it.

- [ ] **Step 7: Verify on a real device**

Run `paddock`, open it on a phone, open a Claude agent, tap **Show earlier** twice.
Expected: earlier turns appear, prepended, without the scroll position jumping; no option buttons render for journal content. Record what you saw in the commit message.

- [ ] **Step 8: Commit**

```bash
make check && make check-clean && make test
git add -A
git commit -m "feat: show earlier reads the agent's own log"
```

---

### Task 9: `--demo` can demonstrate it

`README.md` screenshots come from `--demo`, and `docs/roadmap.md` already carries one feature invisible there. Adding a second silently is a choice, not an accident.

**Files:**
- Modify: `src/web/demo/backend.ts`
- Test: `tests/demo.test.ts`

**Interfaces:**
- Consumes: `Agent.hasJournal` (Task 2), the `/history` response shape (Task 7).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `tests/demo.test.ts`:

```ts
test("one demo agent has a journal, so --demo can demonstrate Show earlier", () => {
  // README screenshots come from --demo. A feature invisible there cannot be
  // screenshotted, and the roadmap already records one such gap.
  const agents = demoAgents();
  expect(agents.filter((a) => a.hasJournal).length).toBeGreaterThan(0);
});

test("the demo journal uses invented content", () => {
  // House rule 2. Fixtures and demo data never carry real agent names.
  const lines = demoHistory("d1:p1").lines;
  expect(lines.join("\n")).toContain("flaky-test-fix");
  expect(lines.length).toBeGreaterThan(3);
});
```

Adjust the imported helper names to whatever `src/web/demo/backend.ts` actually exports; do not invent a second demo API.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/demo.test.ts`
Expected: FAIL — no demo agent has `hasJournal`, and `demoHistory` does not exist.

- [ ] **Step 3: Implement**

In `src/web/demo/backend.ts`, set `hasJournal: true` on exactly one seeded agent, and add a canned history response for it — invented content only, in the shape `toLines` produces:

```ts
/**
 * A short canned transcript for the one demo agent that has a journal.
 *
 * Invented content, per house rule 2 — never copied from a real session. It
 * exists so `Show earlier` is demonstrable in the mode README screenshots come
 * from, rather than being a feature only a live herdr can show.
 */
const DEMO_HISTORY: string[] = [
  "you · 13:04",
  "the flaky-test-fix run keeps timing out — take a look",
  "",
  "agent · 13:05",
  "▸ Bash · run the suite",
  "Reproduced it: the retry budget is exhausted before the first assertion.",
  "",
];
```

Serve it from the demo backend's `/history` branch with `source: "journal"`, `hasMore: false`, `cursor: null`, `detail: null`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/demo.test.ts`
Expected: PASS.

- [ ] **Step 5: See it**

Run: `bun run build:web && bun src/server/index.ts --demo`, open `http://127.0.0.1:8787`, open the demo agent, tap **Show earlier**.
Expected: the canned turns appear above the screen.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add -A
git commit -m "feat: --demo can demonstrate journal history"
```

---

## Self-Review

**Spec coverage.** Every section of `docs/design/2026-08-20-journal-history-design.md` maps to a task: the `agent_session` type gap → Task 1; decision 5 (session ids off the wire) → Task 2; the registry seam → Task 3; path safety and the bounded reader → Task 4; decision 4 (exposure) and decision 3's menu stripping → Tasks 5 and 6; the route, its cursor rules and decision 6's logging → Task 7; decisions 1–3 in the client, plus all four docs → Task 8; demo mode → Task 9. The "risk worth stating" is carried by `verifiedAgainst` (Tasks 3 and 6) and asserted by a test.

**Known gaps this plan deliberately leaves.** Codex, pi and OpenCode adapters are out of scope — the registry is the seam, and adding one is an entry plus a module. Paging beyond `MAX_TAIL_BYTES` per request works by repeated requests rather than a streaming read.

**One thing an implementer must not "fix".** `source: "reconstruction"` comes back with `lines: []` and a `200`. That is correct: the server is answering "I have no journal", and the client already holds the reconstruction. Turning it into a `404` or an error would make a working fallback look like a failure.
