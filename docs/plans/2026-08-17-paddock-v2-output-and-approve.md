# paddock v2 — Output Reading and the Approve Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a herdr pane's recent output from a phone, and answer a blocked agent by tapping one of its real prompt options — closing the loop v1 left open.

**Architecture:** No new layers. Actions travel as POST routes whose response returns to the caller; agent state changes ride the delta path v1 already built, so multi-tab consistency is inherited rather than designed. A new `herdr/actions.ts` is the only caller of `agent.read` / `agent.prompt` / `agent.send_keys` / `agent.wait`, and a pure `herdr/prompt-parse.ts` turns a detection snapshot into options. The WebSocket stays strictly server → browser.

**Tech Stack:** Bun (runtime, test runner, bundler), Hono (HTTP), React 19 + Vite (UI), Tailwind v4, TypeScript strict. No new runtime dependencies.

**Spec:** `docs/design/2026-08-17-paddock-plan2-design.md` (builds on `docs/design/2026-08-17-paddock-design.md`)

---

## Global Constraints

Copied from the spec and v1's still-binding rules. Every task's requirements implicitly include these.

- **This repository is PUBLIC.** No real hostnames, domains, absolute home paths, usernames, machine names or emails. Fixtures use invented names only: `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`, `perf-audit`, `lint-config`; `dev-box` as host; `/srv/project` as a working directory.
- **`make check-clean` must pass before every commit.** If it fails, fix the content — never add the string to an ignore list.
- **Render the agent's exact option label.** Never summarise, reorder, or collapse options into a generic "Approve". One real option was *"Yes, and always allow access to tmp/ from this project"* — a persistent policy change, not an approval.
- **Never guess a keystroke.** If parsing fails, `options` is `null` and the UI shows raw output plus a free-text box. Never synthesise a default action.
- **Wait on the agent LEAVING `blocked`**, never on it reaching `working`. Declining an option sends the agent to `idle`, so a `working`-only wait reports a false failure on every rejection.
- **Read source depends on agent state.** `recent` / `recent_unwrapped` return `agent_not_idle` on a blocked agent. Use `visible` when blocked, `recent_unwrapped` otherwise.
- **Never put payloads in a GET query string.** POST bodies only.
- **Never add an application auth token.** Cloudflare Access is the only gate.
- **Never swallow errors.** No empty catch blocks, no unconditional success.
- **`src/shared/types.ts` is the one payload contract**, imported by both sides. Never redeclare a payload shape.
- **Dependency direction is strict:** `herdr/socket → herdr/adapter → state/store → ws/hub → web/`. Nothing upstream imports anything downstream.
- **No device detection, no `isMobile`, no user-agent parsing.** Width media queries for layout, `(pointer: coarse)` / `(hover: hover)` for interaction.
- **Respect `prefers-reduced-motion`** and `env(safe-area-inset-bottom)`.
- **`make test` builds the UI first.** Use `make test`, not bare `bun test`.

### Decisions carried in from the spec's open questions

1. **A long option list scrolls; a label is never truncated.** Truncating an option label reintroduces exactly the ambiguity the never-guess rule exists to prevent — "Yes, and always allow acce…" is worse than no button.
2. **The free-text reply stays reachable even when parsing succeeds.** An operator may want to answer "no, and here's what to do instead" rather than pick an offered option. The raw snapshot is already fetched, so this costs nothing.

### Verified herdr facts

Established by probing a real Claude Code permission prompt. Do not re-derive.

| Fact | Value |
|---|---|
| Prompt lives in | `detection` and `visible` only |
| Option shape | `1.` `2.` `3.`, with `❯` marking the current selection |
| Question line | separable, e.g. `Do you want to proceed?` |
| Answering | `agent.send_keys` with the option digit selects it — verified end to end |
| Blocked + `recent_unwrapped` | fails with `agent_not_idle` (alternate screen) |
| `AgentWaitParams.until` | an **array** of `AgentStatus` |
| Labels | dynamic and context-specific; option 2 was a persistent grant |

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | **Modify.** `PromptOption`, `ParsedPrompt`, `ActionResult`; `Agent.acknowledgedAt`; `sectionFor` takes an `Agent`. |
| `src/server/state/store.ts` | **Modify.** `acknowledge()`; carry `acknowledgedAt` across reconciles; clear it when the agent leaves `done`. |
| `src/server/herdr/adapter.ts` | **Modify.** `toAgent` stamps `acknowledgedAt: null`. |
| `src/server/herdr/prompt-parse.ts` | **New.** Pure: detection snapshot → `ParsedPrompt`. No I/O. |
| `src/server/herdr/actions.ts` | **New.** The only caller of `agent.read` / `prompt` / `send_keys` / `wait`. |
| `src/server/routes.ts` | **Modify.** Four POST routes and the blocked-only scope guard. |
| `src/server/index.ts` | **Modify.** Bind real actions into `AppDeps`. |
| `src/web/api.ts` | **New.** Client POST helpers. |
| `src/web/components/AgentDetail.tsx` | **New.** Bottom sheet <640px, side panel above. |
| `src/web/components/App.tsx` | **Modify.** Open/close the detail sheet. |
| `src/web/components/AgentCard.tsx` | **Modify.** Acknowledge control on `done` cards. |

---

## Task 1: Shared types, the section rule, and the acknowledge flag

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/state/store.ts`
- Modify: `src/server/herdr/adapter.ts`
- Test: `tests/acknowledge.test.ts`

**Interfaces:**
- Consumes: `Agent`, `AgentState`, `Delta`, `SECTION_ORDER`
- Produces:
  - `interface PromptOption { label: string; key: string; selected: boolean }`
  - `interface ParsedPrompt { question: string | null; options: PromptOption[] | null; raw: string }`
  - `interface ActionResult { ok: boolean; detail?: string }`
  - `Agent.acknowledgedAt: number | null`
  - `sectionFor(agent: Agent): Section` — **signature change**, was `sectionFor(state: AgentState)`
  - `AgentStore.acknowledge(agentId: string, now: number): Delta | null`

**Why `sectionFor` changes signature.** An acknowledged `done` agent must leave **Needs you**, and that decision depends on `acknowledgedAt`, not on `state` alone. Adding a second function that accounts for it would give two rules free to drift — the exact failure the shared `compareAgents` comparator was introduced to prevent. There is one rule; it takes the whole agent.

- [ ] **Step 1: Write the failing test**

Create `tests/acknowledge.test.ts`:

```ts
import { expect, test } from "bun:test";
import { AgentStore } from "@server/state/store";
import { sectionFor, type Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "done", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project",
    stateSince: NOW, updatedAt: NOW, acknowledgedAt: null, ...over,
  };
}

test("a done agent is in needs-you until acknowledged", () => {
  expect(sectionFor(agent())).toBe("needs-you");
  expect(sectionFor(agent({ acknowledgedAt: NOW }))).toBe("idle");
});

test("acknowledging a non-done agent changes nothing", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent({ state: "working" })], NOW);
  expect(store.acknowledge("w1:p1", NOW)).toBeNull();
  expect(store.snapshot()[0]!.acknowledgedAt).toBeNull();
});

test("acknowledge stamps the flag and reports an upsert", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const d = store.acknowledge("w1:p1", NOW + 5);
  expect(d!.upserted[0]!.acknowledgedAt).toBe(NOW + 5);
});

test("acknowledging twice is a no-op the second time", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  store.acknowledge("w1:p1", NOW + 5);
  expect(store.acknowledge("w1:p1", NOW + 9)).toBeNull();
});

test("acknowledging an unknown agent returns null", () => {
  const store = new AgentStore("dev-box");
  expect(store.acknowledge("nope:p1", NOW)).toBeNull();
});

// The reconcile re-sends every agent every 30s. If it dropped the flag, an
// acknowledged card would reappear in Needs you within half a minute.
test("a reconcile preserves the acknowledge flag", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  store.acknowledge("w1:p1", NOW + 5);
  store.replaceAll([agent()], NOW + 30_000);
  expect(store.snapshot()[0]!.acknowledgedAt).toBe(NOW + 5);
});

// Acknowledging means "I have dealt with this finish". A new finish is new news.
test("leaving done clears the acknowledge flag", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  store.acknowledge("w1:p1", NOW + 5);
  store.replaceAll([agent({ state: "working" })], NOW + 10);
  expect(store.snapshot()[0]!.acknowledgedAt).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test 2>&1 | grep -A3 acknowledge`
Expected: FAIL — `store.acknowledge is not a function`, and `sectionFor` type errors.

- [ ] **Step 3: Extend the shared contract**

In `src/shared/types.ts`, add to `Agent` after `updatedAt`:

```ts
  /**
   * Epoch ms when the operator dismissed this agent's `done` from paddock,
   * or null.
   *
   * herdr derives `done` from idle-plus-*unseen*, and reading over the socket
   * does not clear it — so without this, finished agents accumulate in Needs
   * you and can never be cleared from a phone. This flag is paddock's own:
   * herdr's `done` stays true, paddock just stops surfacing it.
   */
  acknowledgedAt: number | null;
```

Add the new payload types:

```ts
export interface PromptOption {
  /** The option's text EXACTLY as the agent rendered it. Never rewritten. */
  label: string;
  /** The key to send via agent.send_keys — the option's digit. */
  key: string;
  /** True when the agent's `❯` cursor sits on this option. */
  selected: boolean;
}

export interface ParsedPrompt {
  /** The question line, e.g. "Do you want to proceed?". Null when not found. */
  question: string | null;
  /**
   * The parsed options, or null when the snapshot could not be parsed.
   *
   * null is an OUTCOME, not an error: the UI falls back to raw output plus a
   * free-text reply. A mislabelled Approve button is worse than no button.
   */
  options: PromptOption[] | null;
  /** The snapshot as read. Always present, so the UI can always show something. */
  raw: string;
}

export interface ActionResult {
  ok: boolean;
  detail?: string;
}
```

Replace `sectionFor`:

```ts
export function sectionFor(agent: Agent): Section {
  if (agent.state === "blocked") return "needs-you";
  // An acknowledged finish has been dealt with; it stops competing for
  // attention with agents that still need some.
  if (agent.state === "done") return agent.acknowledgedAt === null ? "needs-you" : "idle";
  if (agent.state === "working") return "working";
  return "idle";
}
```

Update `compareAgents` to match:

```ts
  const sa = SECTION_ORDER.indexOf(sectionFor(a));
  const sb = SECTION_ORDER.indexOf(sectionFor(b));
```

- [ ] **Step 4: Carry the flag through the store**

In `src/server/state/store.ts`, inside `replaceAll`'s merge, alongside the existing `stateSince` preservation:

```ts
        // Carried like stateSince, and for the same reason: the 30s reconcile
        // rebuilds every agent from herdr, which knows nothing about this flag.
        // Dropping it would resurrect an acknowledged card within half a minute.
        // Cleared on leaving `done`, because a fresh finish is fresh news.
        acknowledgedAt: next.state === "done" ? prev.acknowledgedAt : null,
```

Add the method:

```ts
  /**
   * Dismiss a `done` agent from Needs you. Returns null when the agent is
   * unknown, not `done`, or already acknowledged — so a double-tap does not
   * broadcast a no-op delta to every browser.
   */
  acknowledge(agentId: string, now: number): Delta | null {
    const prev = this.agents.get(agentId);
    if (!prev || prev.state !== "done" || prev.acknowledgedAt !== null) return null;
    const next = { ...prev, acknowledgedAt: now, updatedAt: now };
    this.agents.set(agentId, next);
    return { upserted: [next], removedIds: [] };
  }
```

In `src/server/herdr/adapter.ts`, `toAgent` stamps the field:

```ts
    acknowledgedAt: null,
```

- [ ] **Step 5: Fix the call sites the signature change breaks**

`sectionFor` now takes an `Agent`. Update `src/web/components/Section.tsx`'s `groupAgents` and any other caller. Run `make check` and fix every type error — the compiler enumerates them.

- [ ] **Step 6: Run the tests**

Run: `make test`
Expected: 7 new tests pass; the existing suite stays green.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean
git add src/shared/types.ts src/server/state/store.ts src/server/herdr/adapter.ts src/web/components/Section.tsx tests/acknowledge.test.ts
git commit -m "feat: acknowledge a done agent so it leaves Needs you"
```

---

## Task 2: The prompt parser

**Files:**
- Create: `src/server/herdr/prompt-parse.ts`
- Test: `tests/prompt-parse.test.ts`

**Interfaces:**
- Consumes: `ParsedPrompt`, `PromptOption` from `@shared/types`
- Produces: `parsePrompt(raw: string): ParsedPrompt`

This is the piece most likely to break silently when an agent's TUI changes, so it is pure — no I/O, no herdr calls — and carries the heaviest test coverage in the plan.

**The committed fixture is sanitised.** The real capture contains a live machine's paths and third-party banner URLs. The fixture below reproduces the exact *structure* with invented content, per the public-repo rule.

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-parse.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parsePrompt } from "@server/herdr/prompt-parse";

// Structure copied from a real Claude Code permission prompt; content invented.
const REAL_SHAPE = `
 Bash command

   echo hello > /srv/project/out.txt
   Write a greeting to a file

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to project/ from this project
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`;

test("parses the real prompt shape", () => {
  const p = parsePrompt(REAL_SHAPE);
  expect(p.question).toBe("Do you want to proceed?");
  expect(p.options).toHaveLength(3);
  expect(p.options![0]).toEqual({ key: "1", label: "Yes", selected: true });
});

// The whole reason paddock renders real labels: this option is a persistent
// policy change, and a generic "Approve" would be ambiguous against option 1.
test("keeps a long option label verbatim, never truncated or summarised", () => {
  const p = parsePrompt(REAL_SHAPE);
  expect(p.options![1]!.label).toBe("Yes, and always allow access to project/ from this project");
});

test("marks only the option the cursor sits on", () => {
  const p = parsePrompt(REAL_SHAPE);
  expect(p.options!.map((o) => o.selected)).toEqual([true, false, false]);
});

test("handles the cursor on a non-first option", () => {
  const p = parsePrompt("Continue?\n  1. Yes\n ❯ 2. No\n");
  expect(p.options!.map((o) => o.selected)).toEqual([false, true]);
});

test("parses a four-option prompt", () => {
  const p = parsePrompt("Pick one?\n ❯ 1. A\n   2. B\n   3. C\n   4. D\n");
  expect(p.options!.map((o) => o.key)).toEqual(["1", "2", "3", "4"]);
});

test("returns options: null when there is no prompt at all", () => {
  const p = parsePrompt("just some output\nand another line\n");
  expect(p.options).toBeNull();
  expect(p.raw).toContain("just some output");
});

// A truncated capture must not yield a half-list the operator could tap.
test("returns options: null when the numbering is not a contiguous run from 1", () => {
  expect(parsePrompt("Proceed?\n   2. Yes\n   3. No\n").options).toBeNull();
  expect(parsePrompt("Proceed?\n   1. Yes\n   3. No\n").options).toBeNull();
});

test("returns options: null for a single option", () => {
  // One option is ambiguous — it is as likely to be a numbered list in output.
  expect(parsePrompt("Note?\n   1. Only\n").options).toBeNull();
});

test("takes the question nearest the options, not the first question in the buffer", () => {
  const p = parsePrompt("Earlier question?\n  some output\n\nDo you want to proceed?\n ❯ 1. Yes\n   2. No\n");
  expect(p.question).toBe("Do you want to proceed?");
});

test("always returns raw, even when parsing fails", () => {
  expect(parsePrompt("nothing here").raw).toBe("nothing here");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test 2>&1 | grep -A3 prompt-parse`
Expected: FAIL — cannot resolve `@server/herdr/prompt-parse`.

- [ ] **Step 3: Implement the parser**

Create `src/server/herdr/prompt-parse.ts`:

```ts
import type { ParsedPrompt, PromptOption } from "@shared/types";

/** `❯ 1. Yes` / `   2. No` — the cursor marker is optional. */
const OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/;
const QUESTION_RE = /^\s*(\S.*\?)\s*$/;

/**
 * Turn a `detection` snapshot into options paddock can render.
 *
 * Returning `options: null` is a first-class outcome, not a failure: the UI
 * falls back to raw output plus a free-text reply. Every guard below prefers
 * null over a plausible-looking list, because a wrong button is worse than no
 * button — a mis-tap could select "no, and here's what to do instead".
 */
export function parsePrompt(raw: string): ParsedPrompt {
  const options: PromptOption[] = [];
  let question: string | null = null;

  for (const line of raw.split("\n")) {
    const opt = OPTION_RE.exec(line);
    if (opt) {
      options.push({ key: opt[2]!, label: opt[3]!, selected: Boolean(opt[1]) });
      continue;
    }
    // Keep the LAST question seen before the options start, so surrounding
    // scrollback cannot supply a stale question line.
    if (options.length === 0) {
      const q = QUESTION_RE.exec(line);
      if (q) question = q[1]!.trim();
    }
  }

  // Two guards, both preferring null:
  //  - fewer than two options is as likely to be a numbered list in output
  //  - non-contiguous numbering means a truncated capture or an accidental
  //    match, and a partial list is tappable and wrong
  const usable =
    options.length >= 2 && options.every((o, i) => o.key === String(i + 1));

  return { question, options: usable ? options : null, raw };
}
```

- [ ] **Step 4: Run the tests**

Run: `make test`
Expected: 10 new tests pass.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/herdr/prompt-parse.ts tests/prompt-parse.test.ts
git commit -m "feat: parse a blocked agent's real prompt options"
```

---

## Task 3: herdr actions

**Files:**
- Create: `src/server/herdr/actions.ts`
- Test: `tests/actions.test.ts`

**Interfaces:**
- Consumes: `request`, `HERDR_TIMEOUT_MS` from `@server/herdr/socket`; `AgentState` from `@shared/types`
- Produces:
  - `type ReadSource = "detection" | "visible" | "recent_unwrapped"`
  - `readSourceFor(state: AgentState): ReadSource`
  - `interface HerdrActions { readOutput; readDetection; sendOptionKey; sendReply; waitUntilUnblocked }`
  - `createActions(socketPath: string): HerdrActions`

`createActions` binds the socket path once, so routes take an injectable object and tests need no unix socket.

- [ ] **Step 1: Write the failing test**

Create `tests/actions.test.ts`. Reuse the strict fake-herdr pattern from `tests/socket.test.ts` — one response per connection, then close.

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActions, readSourceFor } from "@server/herdr/actions";

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

async function fakeHerdr(handler: (req: any) => object) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-actions-"));
  const path = join(dir, "h.sock");
  const seen: any[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(s, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          seen.push(req);
          s.write(JSON.stringify({ id: req.id, result: handler(req) }) + "\n");
          s.end(); // herdr closes after one response
        }
      },
    },
  });
  stop = () => server.stop(true);
  return { path, seen };
}

// The finding that shapes this module: recent_unwrapped FAILS on a blocked
// agent, because its prompt renders on the terminal's alternate screen.
test("a blocked agent is read from visible, everything else from recent_unwrapped", () => {
  expect(readSourceFor("blocked")).toBe("visible");
  expect(readSourceFor("working")).toBe("recent_unwrapped");
  expect(readSourceFor("idle")).toBe("recent_unwrapped");
  expect(readSourceFor("done")).toBe("recent_unwrapped");
});

test("readOutput asks herdr for the state-appropriate source", async () => {
  const { path, seen } = await fakeHerdr(() => ({ text: "line one\nline two" }));
  const out = await createActions(path).readOutput("w1:p1", "blocked", 40);
  expect(seen[0].method).toBe("agent.read");
  expect(seen[0].params.source).toBe("visible");
  expect(seen[0].params.lines).toBe(40);
  expect(out.lines).toEqual(["line one", "line two"]);
  expect(out.source).toBe("visible");
});

test("readDetection always uses the detection source", async () => {
  const { path, seen } = await fakeHerdr(() => ({ text: "snapshot" }));
  expect(await createActions(path).readDetection("w1:p1")).toBe("snapshot");
  expect(seen[0].params.source).toBe("detection");
});

test("sendOptionKey sends the digit as a key", async () => {
  const { path, seen } = await fakeHerdr(() => ({ type: "ok" }));
  await createActions(path).sendOptionKey("w1:p1", "2");
  expect(seen[0].method).toBe("agent.send_keys");
  expect(seen[0].params.keys).toEqual(["2"]);
});

test("sendReply submits text through agent.prompt", async () => {
  const { path, seen } = await fakeHerdr(() => ({ type: "ok" }));
  await createActions(path).sendReply("w1:p1", "no, run the tests first");
  expect(seen[0].method).toBe("agent.prompt");
  expect(seen[0].params.text).toBe("no, run the tests first");
});

// Declining an option sends the agent to idle, NOT working. Waiting on
// `working` alone would report a false failure on every rejection.
test("waitUntilUnblocked waits on leaving blocked, not on reaching working", async () => {
  const { path, seen } = await fakeHerdr(() => ({ agent_status: "idle" }));
  await createActions(path).waitUntilUnblocked("w1:p1", 5_000);
  expect(seen[0].method).toBe("agent.wait");
  expect(seen[0].params.until.sort()).toEqual(["done", "idle", "working"]);
  expect(seen[0].params.timeout_ms).toBe(5_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test 2>&1 | grep -A3 actions`
Expected: FAIL — cannot resolve `@server/herdr/actions`.

- [ ] **Step 3: Implement the actions module**

Create `src/server/herdr/actions.ts`:

```ts
import { request } from "@server/herdr/socket";
import type { AgentState } from "@shared/types";

export type ReadSource = "detection" | "visible" | "recent_unwrapped";

/** Default line budget for an on-demand read. Output is never streamed. */
export const DEFAULT_READ_LINES = 120;

/**
 * Pick the read source by agent state.
 *
 * `recent` and `recent_unwrapped` return `agent_not_idle` on a BLOCKED agent:
 * its prompt renders on the terminal's alternate screen, whose history "can
 * only be captured by scrolling while idle" — herdr's own error recommends
 * `visible`. This bites precisely on the agents most worth reading, so the
 * choice is state-driven rather than a preference.
 */
export function readSourceFor(state: AgentState): ReadSource {
  return state === "blocked" ? "visible" : "recent_unwrapped";
}

export interface HerdrActions {
  readOutput(target: string, state: AgentState, lines?: number): Promise<{ lines: string[]; source: ReadSource }>;
  readDetection(target: string): Promise<string>;
  sendOptionKey(target: string, key: string): Promise<void>;
  sendReply(target: string, text: string): Promise<void>;
  waitUntilUnblocked(target: string, timeoutMs?: number): Promise<void>;
}

/** Binds the socket path once so routes can take an injectable object. */
export function createActions(socketPath: string): HerdrActions {
  return {
    async readOutput(target, state, lines = DEFAULT_READ_LINES) {
      const source = readSourceFor(state);
      const res = await request<{ text?: string }>(socketPath, "agent.read", {
        target, source, lines, format: "text", strip_ansi: true,
      });
      return { lines: (res.text ?? "").split("\n"), source };
    },

    async readDetection(target) {
      const res = await request<{ text?: string }>(socketPath, "agent.read", {
        target, source: "detection", lines: 60, format: "text", strip_ansi: true,
      });
      return res.text ?? "";
    },

    async sendOptionKey(target, key) {
      await request(socketPath, "agent.send_keys", { target, keys: [key] });
    },

    async sendReply(target, text) {
      await request(socketPath, "agent.prompt", { target, text });
    },

    async waitUntilUnblocked(target, timeoutMs = 15_000) {
      // Wait on LEAVING blocked. Declining an option settles the agent on
      // `idle`, so a `working`-only wait reports a false failure on every
      // rejection — confirmed during the probe, where answering "Yes" also
      // settled on idle once the command finished.
      await request(socketPath, "agent.wait", {
        target, until: ["working", "idle", "done"], timeout_ms: timeoutMs,
      });
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `make test`
Expected: 6 new tests pass.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/herdr/actions.ts tests/actions.test.ts
git commit -m "feat: herdr action wrappers with state-aware read source"
```

---

## Task 4: POST routes and the scope guard

**Files:**
- Modify: `src/server/routes.ts`
- Modify: `src/server/index.ts`
- Test: `tests/action-routes.test.ts`

**Interfaces:**
- Consumes: `HerdrActions` (Task 3), `parsePrompt` (Task 2), `AgentStore` (Task 1)
- Produces: `AppDeps.actions?: HerdrActions`; four POST routes

**The scope guard is the security boundary.** `agent.prompt` accepts arbitrary text, so "only reply to a blocked agent" is enforced at the API layer against the store — never trusted to the UI.

- [ ] **Step 1: Write the failing test**

Create `tests/action-routes.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "blocked", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project",
    stateSince: NOW, updatedAt: NOW, acknowledgedAt: null, ...over,
  };
}

function harness(a: Agent = agent()) {
  const store = new AgentStore("dev-box");
  store.replaceAll([a], NOW);
  const calls: string[] = [];
  const actions = {
    async readOutput() { calls.push("readOutput"); return { lines: ["out"], source: "visible" as const }; },
    async readDetection() { calls.push("readDetection"); return "Proceed?\n ❯ 1. Yes\n   2. No\n"; },
    async sendOptionKey(_t: string, k: string) { calls.push(`key:${k}`); },
    async sendReply(_t: string, text: string) { calls.push(`reply:${text}`); },
    async waitUntilUnblocked() { calls.push("wait"); },
  };
  const hub = new Hub({ now: () => NOW });
  const app = createApp({
    store, hub, actions,
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW }),
  });
  return { app, store, calls };
}

const post = (app: any, path: string, body?: object) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

test("output returns lines and the source used", async () => {
  const { app } = harness();
  const res = await post(app, "/api/agents/w1:p1/output");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ lines: ["out"], source: "visible" });
});

test("prompt returns parsed options", async () => {
  const { app } = harness();
  const body = await (await post(app, "/api/agents/w1:p1/prompt")).json();
  expect(body.options).toHaveLength(2);
  expect(body.options[0]).toEqual({ key: "1", label: "Yes", selected: true });
});

test("answering by key sends the digit and confirms", async () => {
  const { app, calls } = harness();
  const res = await post(app, "/api/agents/w1:p1/answer", { key: "2" });
  expect(await res.json()).toEqual({ ok: true });
  expect(calls).toEqual(["key:2", "wait"]);
});

test("answering by text goes through agent.prompt", async () => {
  const { app, calls } = harness();
  await post(app, "/api/agents/w1:p1/answer", { text: "run tests first" });
  expect(calls).toEqual(["reply:run tests first", "wait"]);
});

// THE scope guard. agent.prompt accepts arbitrary text, so this is enforced
// against the store rather than trusted to the UI.
test("answering a NON-blocked agent is refused, and nothing is sent", async () => {
  const { app, calls } = harness(agent({ state: "working" }));
  const res = await post(app, "/api/agents/w1:p1/answer", { key: "1" });
  expect(res.status).toBe(409);
  expect((await res.json()).ok).toBe(false);
  expect(calls).toEqual([]);
});

test("answering an unknown agent is refused", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/nope:p1/answer", { key: "1" })).status).toBe(404);
  expect(calls).toEqual([]);
});

test("an answer with neither key nor text is rejected", async () => {
  const { app, calls } = harness();
  expect((await post(app, "/api/agents/w1:p1/answer", {})).status).toBe(400);
  expect(calls).toEqual([]);
});

test("ack marks a done agent and is refused for others", async () => {
  const done = harness(agent({ state: "done" }));
  expect((await post(done.app, "/api/agents/w1:p1/ack")).status).toBe(200);
  expect(done.store.snapshot()[0]!.acknowledgedAt).toBe(NOW);

  const blocked = harness();
  expect((await post(blocked.app, "/api/agents/w1:p1/ack")).status).toBe(409);
});

test("a failed action reports ok:false rather than throwing", async () => {
  const { app } = harness();
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app2 = createApp({
    store, hub: new Hub({ now: () => NOW }),
    actions: {
      async readOutput() { return { lines: [], source: "visible" as const }; },
      async readDetection() { return ""; },
      async sendOptionKey() { throw new Error("herdr said no"); },
      async sendReply() {}, async waitUntilUnblocked() {},
    },
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW }),
  });
  const res = await post(app2, "/api/agents/w1:p1/answer", { key: "1" });
  expect(res.status).toBe(502);
  expect((await res.json()).detail).toContain("herdr said no");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test 2>&1 | grep -A3 action-routes`
Expected: FAIL — routes 404.

- [ ] **Step 3: Add the routes**

In `src/server/routes.ts`, extend `AppDeps`:

```ts
  /** herdr actions. Omit in tests that only exercise the read-only API. */
  actions?: HerdrActions;
```

Add before the `/api/*` 404 guard:

```ts
  if (deps.actions) {
    const actions = deps.actions;

    // POST, never GET: a payload in a query string lands in edge access logs.
    app.post("/api/agents/:id/output", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      const body = await c.req.json().catch(() => ({}) as { lines?: number });
      try {
        return c.json(await actions.readOutput(agent.agentId, agent.state, body.lines));
      } catch (err) {
        return c.json({ ok: false, detail: String(err) }, 502);
      }
    });

    app.post("/api/agents/:id/prompt", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      try {
        return c.json(parsePrompt(await actions.readDetection(agent.agentId)));
      } catch (err) {
        return c.json({ ok: false, detail: String(err) }, 502);
      }
    });

    app.post("/api/agents/:id/answer", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);

      // THE scope boundary. agent.prompt accepts arbitrary text, so "only a
      // blocked agent may be answered" is enforced here against the store, not
      // trusted to the UI. If someone answered at the desk first, the agent is
      // no longer blocked and this reply must not be typed into whatever is now
      // on screen.
      if (agent.state !== "blocked") {
        return c.json({ ok: false, detail: `agent is ${agent.state}, no longer blocked` }, 409);
      }

      const body = await c.req.json().catch(() => ({}) as { key?: string; text?: string });
      if (!body.key && !body.text) {
        return c.json({ ok: false, detail: "provide key or text" }, 400);
      }

      try {
        if (body.key) await actions.sendOptionKey(agent.agentId, body.key);
        else await actions.sendReply(agent.agentId, body.text!);
        await actions.waitUntilUnblocked(agent.agentId);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ ok: false, detail: String(err) }, 502);
      }
    });

    app.post("/api/agents/:id/ack", (c) => {
      const delta = deps.store.acknowledge(c.req.param("id"), Date.now());
      if (!delta) return c.json({ ok: false, detail: "not a fresh done agent" }, 409);
      deps.hub.queue(delta); // reaches every other open browser
      return c.json({ ok: true });
    });
  }
```

Import `parsePrompt` and the `HerdrActions` type at the top.

- [ ] **Step 4: Wire real actions in the entry point**

In `src/server/index.ts`, in the non-demo branch, build them alongside the client and pass into `createApp`:

```ts
const actions = createActions(socketPath);
```

Pass `actions` in the `createApp({ ... })` call. In demo mode, omit it — demo has no herdr to act on, and the routes then 404 honestly rather than pretending.

- [ ] **Step 5: Run the tests**

Run: `make test`
Expected: 9 new tests pass.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean
git add src/server/routes.ts src/server/index.ts tests/action-routes.test.ts
git commit -m "feat: action routes with a blocked-only scope guard"
```

---

## Task 5: Client API helpers

**Files:**
- Create: `src/web/api.ts`
- Test: `tests/web-api.test.ts`

**Interfaces:**
- Consumes: `ParsedPrompt`, `ActionResult` from `@shared/types`
- Produces: `fetchOutput`, `fetchPrompt`, `answerWithKey`, `answerWithText`, `acknowledge`

- [ ] **Step 1: Write the failing test**

Create `tests/web-api.test.ts`:

```ts
import { expect, test } from "bun:test";
import { answerWithKey, fetchOutput } from "@web/api";

function stubFetch(status: number, body: object) {
  const seen: { url: string; init: any }[] = [];
  const fn = async (url: string, init: any) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
  };
  return { fn, seen };
}

test("fetchOutput POSTs and returns the parsed body", async () => {
  const { fn, seen } = stubFetch(200, { lines: ["a"], source: "visible" });
  const out = await fetchOutput("w1:p1", 40, fn as any);
  expect(seen[0]!.init.method).toBe("POST");
  expect(seen[0]!.url).toBe("/api/agents/w1%3Ap1/output");
  expect(out.lines).toEqual(["a"]);
});

// A refusal is information the operator needs, not an exception to swallow.
test("a refusal surfaces ok:false with the server's reason", async () => {
  const { fn } = stubFetch(409, { ok: false, detail: "agent is working, no longer blocked" });
  const res = await answerWithKey("w1:p1", "1", fn as any);
  expect(res.ok).toBe(false);
  expect(res.detail).toContain("no longer blocked");
});

test("a network failure becomes an ActionResult, not a throw", async () => {
  const fn = async () => { throw new Error("offline"); };
  const res = await answerWithKey("w1:p1", "1", fn as any);
  expect(res.ok).toBe(false);
  expect(res.detail).toContain("offline");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test 2>&1 | grep -A3 web-api`
Expected: FAIL — cannot resolve `@web/api`.

- [ ] **Step 3: Implement the helpers**

Create `src/web/api.ts`:

```ts
import type { ActionResult, ParsedPrompt } from "@shared/types";

type Fetch = typeof fetch;

/** Agent ids contain a colon (`w1:p1`), so they must be encoded. */
const url = (id: string, action: string) => `/api/agents/${encodeURIComponent(id)}/${action}`;

async function post<T>(path: string, body: object, f: Fetch): Promise<T> {
  const res = await f(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export async function fetchOutput(id: string, lines?: number, f: Fetch = fetch) {
  return post<{ lines: string[]; source: string }>(url(id, "output"), { lines }, f);
}

export async function fetchPrompt(id: string, f: Fetch = fetch) {
  return post<ParsedPrompt>(url(id, "prompt"), {}, f);
}

/**
 * Every action funnels failures into an ActionResult rather than throwing.
 * A refused answer ("someone answered at the desk first") is information the
 * operator needs on screen, not an exception that unmounts the sheet.
 */
async function act(path: string, body: object, f: Fetch): Promise<ActionResult> {
  try {
    return await post<ActionResult>(path, body, f);
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

export const answerWithKey = (id: string, key: string, f: Fetch = fetch) =>
  act(url(id, "answer"), { key }, f);

export const answerWithText = (id: string, text: string, f: Fetch = fetch) =>
  act(url(id, "answer"), { text }, f);

export const acknowledge = (id: string, f: Fetch = fetch) =>
  act(url(id, "ack"), {}, f);
```

- [ ] **Step 4: Run the tests**

Run: `make test`
Expected: 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/web/api.ts tests/web-api.test.ts
git commit -m "feat: client helpers for the action routes"
```

---

## Task 6: The agent detail sheet

**Files:**
- Create: `src/web/components/AgentDetail.tsx`
- Modify: `src/web/components/App.tsx`, `src/web/styles.css`
- Test: `tests/detail-view.test.ts`

**Interfaces:**
- Consumes: `fetchOutput`, `fetchPrompt`, `answerWithKey`, `answerWithText` (Task 5); `Agent`, `ParsedPrompt`
- Produces: `<AgentDetail agent={Agent} onClose={() => void} />`; `optionButtonsFor(prompt): PromptOption[]` (pure, exported for test)

**Layout:** bottom sheet below 640px, side panel above — width media query only, no device detection. Respects `env(safe-area-inset-bottom)` and `prefers-reduced-motion`.

**Two decisions from the spec's open questions:**
- **The option list scrolls; a label is never truncated.** `overflow-y: auto` on the options container, `white-space: normal` on the label. A clipped "Yes, and always allow acce…" reintroduces the ambiguity the whole design avoids.
- **The free-text box is always reachable**, even when options parsed — an operator may want to answer something no option offers.

- [ ] **Step 1: Write the failing test**

Create `tests/detail-view.test.ts`. The repo has no DOM test environment, so the testable surface is a pure function; the component wiring is reviewed, not rendered.

```ts
import { expect, test } from "bun:test";
import { optionButtonsFor } from "@web/components/AgentDetail";

test("renders one button per option, in the agent's order", () => {
  const opts = optionButtonsFor({
    question: "Proceed?", raw: "",
    options: [
      { key: "1", label: "Yes", selected: true },
      { key: "2", label: "Yes, and always allow access to project/", selected: false },
      { key: "3", label: "No", selected: false },
    ],
  });
  expect(opts.map((o) => o.key)).toEqual(["1", "2", "3"]);
});

// The rule the whole design rests on.
test("labels pass through verbatim — never shortened or reworded", () => {
  const long = "Yes, and always allow access to project/ from this project";
  const opts = optionButtonsFor({
    question: null, raw: "",
    options: [{ key: "1", label: long, selected: false }, { key: "2", label: "No", selected: false }],
  });
  expect(opts[0]!.label).toBe(long);
});

test("no options means no buttons, so the free-text path is the only one offered", () => {
  expect(optionButtonsFor({ question: null, options: null, raw: "some output" })).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test 2>&1 | grep -A3 detail-view`
Expected: FAIL — cannot resolve `@web/components/AgentDetail`.

- [ ] **Step 3: Implement the component**

Create `src/web/components/AgentDetail.tsx`:

```tsx
import { useEffect, useState } from "react";
import { answerWithKey, answerWithText, fetchOutput, fetchPrompt } from "@web/api";
import type { ActionResult, Agent, ParsedPrompt, PromptOption } from "@shared/types";

/** Pure, and exported so the label-verbatim rule is testable without a DOM. */
export function optionButtonsFor(prompt: ParsedPrompt): PromptOption[] {
  return prompt.options ?? [];
}

export function AgentDetail({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [output, setOutput] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchOutput(agent.agentId).then((o) => { if (live) setOutput(o.lines); });
    if (agent.state === "blocked") {
      void fetchPrompt(agent.agentId).then((p) => { if (live) setPrompt(p); });
    }
    return () => { live = false; };
  }, [agent.agentId, agent.state]);

  async function run(action: () => Promise<ActionResult>) {
    setBusy(true);
    setResult(await action());
    setBusy(false);
  }

  const options = prompt ? optionButtonsFor(prompt) : [];

  return (
    <aside className="detail" role="dialog" aria-label={`${agent.name} detail`}>
      <header>
        <h2>{agent.name}</h2>
        <p>{agent.task}</p>
        <button type="button" onClick={onClose}>Close</button>
      </header>

      <pre className="output">{output.join("\n")}</pre>

      {agent.state === "blocked" && (
        <section className="answer">
          {prompt?.question && <p className="question">{prompt.question}</p>}

          {/* One button per REAL option, in the agent's order, with the agent's
              exact label. The container scrolls; labels wrap. Truncating one
              would reintroduce the ambiguity this design exists to avoid — a
              clipped "Yes, and always allow acce…" is unreadable as a choice. */}
          <div className="options">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                disabled={busy}
                aria-pressed={o.selected}
                onClick={() => void run(() => answerWithKey(agent.agentId, o.key))}
              >
                {o.label}
              </button>
            ))}
          </div>

          {/* Always offered, even when options parsed: the operator may want to
              say something no option covers. When options is null this is the
              only path — paddock never invents a default action. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (reply.trim()) void run(() => answerWithText(agent.agentId, reply.trim()));
            }}
          >
            <label htmlFor="reply">Reply</label>
            <input
              id="reply" value={reply} disabled={busy}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Type an answer instead"
            />
            <button type="submit" disabled={busy || !reply.trim()}>Send</button>
          </form>

          {result && (
            <p className={result.ok ? "ok" : "warn"} role="status">
              {result.ok ? "Sent." : (result.detail ?? "Failed.")}
            </p>
          )}
        </section>
      )}
    </aside>
  );
}
```

- [ ] **Step 4: Add the layout**

In `src/web/styles.css`:

```css
/* Bottom sheet on a narrow screen, side panel on a wide one. A width media
   query only — no device detection anywhere in this project. */
.detail {
  position: fixed;
  inset: auto 0 0 0;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--surface);
  border-top: 1px solid var(--border);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

@media (min-width: 640px) {
  .detail {
    inset: 0 0 0 auto;
    width: min(30rem, 50vw);
    max-height: none;
    border-top: 0;
    border-left: 1px solid var(--border);
  }
}

/* Options scroll; labels wrap. Never truncate an option label. */
.detail .options { display: grid; gap: 0.5rem; max-height: 40vh; overflow-y: auto; }
.detail .options button { white-space: normal; text-align: left; min-height: 2.75rem; }
.detail .output { white-space: pre-wrap; overflow-x: auto; font-family: ui-monospace, monospace; }
```

- [ ] **Step 5: Wire it into App.tsx**

Add `const [openId, setOpenId] = useState<string | null>(null)`, pass a select handler down to the rows and cards, and render `<AgentDetail>` when `openId` matches a known agent. Keep the `ConnectionBanner` outside the `data-stale` wrapper, as it is today.

- [ ] **Step 6: Run the tests and build**

Run: `make test && make build`
Expected: 3 new tests pass; the Vite build succeeds.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean
git add src/web/components/AgentDetail.tsx src/web/components/App.tsx src/web/styles.css tests/detail-view.test.ts
git commit -m "feat: agent detail sheet with real option buttons and a reply box"
```

---

## Task 7: The acknowledge control

**Files:**
- Modify: `src/web/components/AgentCard.tsx`, `src/web/components/App.tsx`
- Test: `tests/acknowledge-ui.test.ts`

**Interfaces:**
- Consumes: `acknowledge` (Task 5); `Agent.acknowledgedAt` (Task 1)
- Produces: `showAcknowledge(agent: Agent): boolean` — pure, exported for test

- [ ] **Step 1: Write the failing test**

Create `tests/acknowledge-ui.test.ts`:

```ts
import { expect, test } from "bun:test";
import { showAcknowledge } from "@web/components/AgentCard";
import type { Agent } from "@shared/types";

const base: Agent = {
  hostId: "dev-box", agentId: "w1:p1", name: "docs-cleanup", task: "Tidy the README",
  state: "done", workspaceId: "w1", workspaceLabel: null, cwd: "/srv/project",
  stateSince: 1, updatedAt: 1, acknowledgedAt: null,
};

test("offered on a fresh done agent", () => {
  expect(showAcknowledge(base)).toBe(true);
});

test("not offered once acknowledged", () => {
  expect(showAcknowledge({ ...base, acknowledgedAt: 2 })).toBe(false);
});

// Dismissing a blocked agent would hide something that still needs an answer.
test("never offered on a blocked agent", () => {
  expect(showAcknowledge({ ...base, state: "blocked" })).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test 2>&1 | grep -A3 acknowledge-ui`
Expected: FAIL — `showAcknowledge` is not exported.

- [ ] **Step 3: Implement**

In `src/web/components/AgentCard.tsx`:

```tsx
/**
 * Only a finished agent can be dismissed, and only once.
 *
 * Never a blocked agent: dismissing one would hide something that still needs
 * an answer, which is the opposite of what Needs you is for.
 */
export function showAcknowledge(agent: Agent): boolean {
  return agent.state === "done" && agent.acknowledgedAt === null;
}
```

Render a "Dismiss" button when it returns true, calling `acknowledge(agent.agentId)`. The card disappears from **Needs you** when the resulting delta arrives — no local state, so every open browser agrees.

- [ ] **Step 4: Run the tests**

Run: `make test && make build`
Expected: 3 new tests pass; build succeeds.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/web/components/AgentCard.tsx src/web/components/App.tsx tests/acknowledge-ui.test.ts
git commit -m "feat: dismiss a finished agent from Needs you"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/architecture.md`, `docs/decisions.md`, `docs/gotchas.md`, `docs/roadmap.md`, `README.md`

- [ ] **Step 1: Update the module table**

Add `herdr/actions.ts`, `herdr/prompt-parse.ts`, `web/api.ts` and `web/components/AgentDetail.tsx` to `docs/architecture.md`'s table, and describe the POST-routes-plus-delta transport. **Verify every claim against the code before writing it** — three false claims were found in this file during v1, and each one read as authoritative because it came from a doc.

- [ ] **Step 2: Record the decisions**

In `docs/decisions.md`, add:
- Actions are POST routes; state changes ride the existing delta path. Rejected: a `ClientMessage` union over the WebSocket (needs correlation IDs the protocol lacks, and error handling across a reconnecting socket is harder than an HTTP status), and POST-only with no delta (two devices would disagree until the next reconcile).
- Persistent-grant options are rendered verbatim with no special treatment. Detecting them would mean matching label text against a pattern — the guessing the design forbids.
- The acknowledge flag is paddock-local and never sent to herdr. `agent.focus` would clear `done` at the source but yanks desktop UI focus.

- [ ] **Step 3: Update gotchas and roadmap**

`docs/gotchas.md` already carries the blocked-agent read-source and option-parsing entries. Add: **waiting on `--until working` after answering reports a false failure whenever an option declines** — wait on leaving `blocked`.

In `docs/roadmap.md`, remove the approve path and detail sheet from the gaps list, and note that Web Push remains the next increment.

- [ ] **Step 4: Update the README**

Describe the approve path in the feature list. Screenshots still come from `--demo` only.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add docs/ README.md
git commit -m "docs: record the approve path and its decisions"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 Scope — detail view | 6 |
| §1 Scope — read output | 3, 4, 6 |
| §1 Scope — tap real options | 2, 4, 6 |
| §1 Scope — free-text fallback | 4, 6 |
| §1 Scope — acknowledge | 1, 4, 7 |
| §2 Probe findings encoded | 2 (parser shape), 3 (read source), 3 (wait semantics) |
| §3 Architecture / modules | 2, 3, 5, 6 |
| §4 Transport, four routes | 4 |
| §5 Read source by state | 3 |
| §6 Approve path + scope guard | 4, 6 |
| §7 Acknowledge | 1, 4, 7 |
| §8 Error handling | 4, 5 |
| §9 Testing + sanitised fixture | 2 |
| §10 Open questions | Settled in Global Constraints |

**Gaps, stated rather than hidden:**
- **No React render test** for the detail sheet — the repo still has no DOM test environment, so the testable surface is `optionButtonsFor` and `showAcknowledge`. The component's wiring is reviewed, not rendered. Same limitation v1 disclosed.
- **Demo mode has no actions.** `createApp` receives no `actions` in `--demo`, so the routes 404. Screenshots show the sheet's output pane only. Honest, but it means the approve path cannot be demonstrated without herdr.
- **`/output` and `/prompt` re-scan the store** with `.find()` on every request. Fine at this scale (tens of agents), noted so it is a decision rather than an oversight.

**2. Placeholder scan** — no TBD/TODO. Every code step contains runnable code. Task 8 specifies each doc's required content rather than its prose.

**3. Type consistency** — `PromptOption` / `ParsedPrompt` / `ActionResult` (Task 1) are consumed unchanged in 2, 4, 5, 6. `Agent.acknowledgedAt` (Task 1) is consumed in 4 and 7. `HerdrActions` (Task 3) is the injected shape in Task 4 and satisfied by `createActions`. `sectionFor`'s signature change is handled in Task 1 Step 5, which compiles the whole tree.
