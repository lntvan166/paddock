# paddock v1 — Read-Only Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web dashboard that shows every herdr agent's name, current task, and state, triaged by what needs attention, usable from a phone.

**Architecture:** One Bun process connects to the herdr unix socket over newline-delimited JSON, subscribes to `pane.agent_status_changed`, and keeps an authoritative in-memory store. A WebSocket hub pushes a snapshot on connect and deltas after. The React UI renders three fixed sections — Needs you, Working, Idle. Dependency direction is strictly one-way: `socket → adapter → store → hub → web`.

**Tech Stack:** Bun (runtime, test runner, bundler), Hono (HTTP), React 19 + Vite (UI), Tailwind v4, TypeScript strict. No other runtime dependencies.

**Spec:** `docs/design/2026-08-17-paddock-design.md`

**Scope:** This plan delivers the complete **read-only** dashboard — a working, useful product on its own.

Reading pane output and answering blocked agents are **out of scope** and belong to a future **v2 interaction plan that does not exist yet**. It was deliberately not written, because Task 2's probe determines its shape: if blocked-prompt options parse, v2 gets real option buttons; if not, v2 ships only a free-text reply box. Writing it before knowing that would mean planning two different features and discarding one. When v1 is done and Task 2 is answered, run `superpowers:brainstorming` then `superpowers:writing-plans` again for v2.

---

## Prerequisites

Verified present on the development machine on 2026-08-17. Confirm before Task 1.

| Requirement | Verified | Check |
|---|---|---|
| Bun ≥ 1.3 | 1.3.14 | `bun --version` |
| Node ≥ 20 (Vite's toolchain) | 22.18.0 | `node --version` |
| herdr running, protocol 19 | 0.8.0 | `herdr api schema \| head -3` |
| herdr socket reachable | yes | `test -S "$HOME/.config/herdr/herdr.sock"` |

**Bun unix-socket APIs used by Task 4 are verified working on 1.3.14:**
`Bun.listen({unix, socket})`, `Bun.connect({unix, socket})`, newline-delimited
round-trip, and server-pushed id-less frames arriving on the client's `data`
handler. Do not re-derive these.

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **This repository is PUBLIC.** No real hostnames, domains, tunnel IDs, org/team names, absolute home paths, usernames, machine names, emails, employer service names or ticket codes. Fixtures and tests use invented agent names only: `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`, `perf-audit`, `lint-config`.
- **`make check-clean` must pass before every commit.** If it fails, fix the content — never add the string to the ignore list.
- **herdr protocol is 19.** Assert on connect; fail with a readable message naming expected and actual.
- **Use `agent.list`, never `pane.list`.** Only `agent.list` returns `name`.
- **Never label an agent from `basename(cwd)`.**
- **Never swallow errors.** No `2>/dev/null`, no unconditional `exit 0`, no empty catch blocks.
- **No application auth token.** Cloudflare Access is the only gate. A token would 401 `/sw.js` and disable the service worker.
- **Derive the WebSocket URL from `location` unconditionally.** No hostname allowlist or special-casing.
- **No device detection.** No `isMobile`, no user-agent parsing. Width media queries for layout, `(pointer: coarse)`/`(hover: hover)` for interaction, capability + install state for install prompts.
- **Never define a colour only inside a media query.** Tokens on bare `:root`, redefined under `prefers-color-scheme` and `[data-theme]`.
- **Bind loopback only.** Server listens on `127.0.0.1`. Docker publishes `127.0.0.1:8787:8787`, never `8787:8787`.
- **Dependency direction:** nothing upstream imports anything downstream. `store.ts` must not know about transport; `hub.ts` must not know about herdr.

### Verified herdr socket facts

Established by probing a live herdr 0.8.0. Do not re-derive.

| Fact | Value |
|---|---|
| Socket path | `$HOME/.config/herdr/herdr.sock` (override: `PADDOCK_HERDR_SOCKET`) |
| Framing | Newline-delimited JSON |
| Request | `{"id": string, "method": string, "params": object}` — `params` required even when empty |
| Success | `{"id": string, "result": object}` |
| Error | `{"id": string, "error": object}` |
| Event | `{"event": string, "data": object}` — **no `id`**, which is how events are told apart from responses |
| Version check | `ping` → `result: {type:"pong", version, protocol, capabilities}` |
| Agent list | `agent.list` with `params: {}` → `result: {type:"agent_list", agents: [...]}` |
| **Connection lifetime** | **One request per connection.** herdr writes one response and closes. A second request gets `EPIPE`; two requests pipelined in one write get one response, then close. |
| **Stream exception** | `events.subscribe` keeps its connection open as an event stream. **No further request may be sent on it** — doing so kills the connection. |
| Subscribable events | **27 types.** `Subscription` in the schema enumerates them; the 3-item `SubscriptionEventKind` is the *delivery* enum, not the subscribable set. |
| Subscribe (status) | `events.subscribe`, `params: {subscriptions: [{type: "pane.agent_status_changed", pane_id: "<id>"}]}` — **`pane_id` is required**; omitting it returns `invalid_request: missing field pane_id` |
| Subscribe (global) | `pane.agent_detected`, `pane.closed`, `pane.exited` take **no** `pane_id` |
| Multiple subscriptions | One `events.subscribe` call carries per-pane and global entries together, so the whole set costs one call |
| **Delivered event names** | Dotted for the 3 `SubscriptionEventKind` types (`pane.agent_status_changed`), **underscored for all others** (`pane_closed`, `pane_agent_detected`). Subscribing with `pane.closed` and matching on `pane.closed` silently never fires. |
| Status event payload | `{agent, agent_status, pane_id, workspace_id}` — plus optional `display_agent`, `title`, `state_labels` |
| Reported vs computed state | A process reports `idle\|working\|blocked\|unknown` via `pane.report_agent`. `done` is **derived by herdr** (idle + tab unseen in the UI) and is never reported. |

`agent.list` agent fields (`AgentInfo`, 22 fields — from the schema, not from a
sample response, which omits absent optionals): `agent`, `agent_session`,
`agent_status`, `cwd`, `display_agent`, `focused`, `foreground_cwd`,
`interactive_ready`, `launch_pending`, `name`, `pane_id`, `revision`,
`screen_detection_skipped`, `state_change_seq`, `state_labels`, `tab_id`,
`terminal_id`, `terminal_title`, `terminal_title_stripped`, `title`, `tokens`,
`workspace_id`.

`pane.list` returns `PaneInfo`, which has **no `name`** (it has `label`). That is
the whole reason for the `agent.list` rule.

**Four consequences that shape the design:**

1. `agent.list` returns `workspace_id` but **no workspace label**. Labels require a separate `workspace.list` call, joined during reconcile.
2. `pane.agent_status_changed` carries `pane_id`, `workspace_id`, `agent_status`, `agent`, `display_agent`, `title`, `state_labels` — but **no `name`**. Events therefore merge into an existing store entry keyed by `pane_id`. An event for an unknown `pane_id` triggers an immediate reconcile to learn its name.
3. Nothing in `agent.list` or the event carries a timestamp. `stateSince` is stamped by paddock on first observation of a state.
4. **The subscription set depends on the pane set, so it is not static.** Status events are per-pane, so paddock must `agent.list` first, then subscribe naming every agent pane. When `pane_agent_detected` or `pane_closed` fires, the set is stale: re-open the stream with the new set and reconcile. This replaces "subscribe once at startup" and is the single biggest structural difference from the original design.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` | Toolchain |
| `Makefile` | All developer commands |
| `scripts/check-private.sh` | Public-repo leak scanner |
| `scripts/gen-herdr-types.ts` | herdr schema → committed `.d.ts` |
| `src/shared/types.ts` | The one payload contract |
| `src/shared/herdr-api.d.ts` | Generated, committed |
| `src/server/herdr/socket.ts` | NDJSON unix socket client. Only file speaking the wire format. |
| `src/server/herdr/adapter.ts` | herdr payloads → `Agent`. Only file doing field mapping. |
| `src/server/state/store.ts` | Authoritative `Map`, delta computation |
| `src/server/ws/hub.ts` | Browser fan-out, burst coalescing |
| `src/server/demo.ts` | Synthetic agents for `--demo` |
| `src/server/routes.ts` | Hono routes |
| `src/server/index.ts` | Wiring + CLI arg parsing |
| `src/web/main.tsx` | React entry |
| `src/web/store.ts` | Client state + WS lifecycle |
| `src/web/styles.css` | Design tokens |
| `src/web/components/*.tsx` | One component per file |
| `Dockerfile`, `docker-compose.yml` | Deployment |

---

## Task 1: Repo scaffold and the public-repo gate

The leak scanner comes first because every later commit depends on it.

**Files:**
- Create: `package.json`, `tsconfig.json`, `Makefile`, `scripts/check-private.sh`
- Test: `tests/check-private.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `make check`, `make check-clean`, `bun test` all runnable

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "paddock",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:server": "bun --watch src/server/index.ts",
    "dev:web": "vite",
    "build:web": "vite build",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "paths": {
      "@shared/*": ["./src/shared/*"],
      "@server/*": ["./src/server/*"],
      "@web/*": ["./src/web/*"]
    },
    "baseUrl": "."
  },
  "include": ["src", "scripts", "tests"]
}
```

- [ ] **Step 3: Write the failing test for the leak scanner**

Create `tests/check-private.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runScanner(files: Record<string, string>): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "paddock-scan-"));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  const proc = Bun.spawn(["bash", join(process.cwd(), "scripts/check-private.sh"), dir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
}

// Fixture strings are ASSEMBLED at runtime rather than written as literals.
// A literal here would match the scanner's own patterns, so `make check-clean`
// would fail on this very file. Concatenation keeps the scanner honest and needs
// no exclusion rule — exclusions are how a scanner quietly stops working.
const HOME_PATH = "/" + "home/" + "someuser/.config";
const PRIVATE_IP = "192." + "168.1.20";
const EMAIL = "person" + "@" + "example.org";
const KEY_HEADER = "-----BEGIN RSA " + "PRIVATE KEY-----";

test("passes on clean content", async () => {
  expect(await runScanner({ "a.ts": "const host = 'paddock.example.com';\n" })).toBe(0);
});

test("fails on an absolute home path with a user segment", async () => {
  expect(await runScanner({ "a.ts": `const p = '${HOME_PATH}';\n` })).toBe(1);
});

test("does NOT fail on a bare path prefix used as documentation", async () => {
  const doc = "Patterns: `/" + "home/`, `/" + "Users/` are scanned.\n";
  expect(await runScanner({ "d.md": doc })).toBe(0);
});

test("fails on an email address", async () => {
  expect(await runScanner({ "a.ts": `// contact ${EMAIL}\n` })).toBe(1);
});

test("fails on a private key header", async () => {
  expect(await runScanner({ "k.pem": `${KEY_HEADER}\n` })).toBe(1);
});

test("fails on an RFC1918 address", async () => {
  expect(await runScanner({ "a.ts": `const ip = '${PRIVATE_IP}';\n` })).toBe(1);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test tests/check-private.test.ts`
Expected: FAIL — `scripts/check-private.sh` does not exist.

- [ ] **Step 5: Write `scripts/check-private.sh`**

The third test is the important one: patterns must match the *shape of a real value*, not the name of a category, or the scanner fails on its own documentation.

```bash
#!/usr/bin/env bash
# Public-repo leak scanner. Fails (exit 1) if anything developer-specific is found.
#
# Patterns here are GENERIC ONLY. Specific strings belong in .private-denylist,
# which is gitignored — a committed denylist would leak what it protects.
#
# Every pattern must require the SHAPE of a real value. A bare `/home/` also
# matches documentation that describes the pattern, so a following path segment
# is required.
set -uo pipefail

ROOT="${1:-.}"
STATUS=0

GENERIC=(
  '(/home|/Users)/[A-Za-z0-9._-]+'
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  '\b(10|127)\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '\b192\.168\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}\b'
  'BEGIN [A-Z ]*PRIVATE KEY'
  '\beyJ[A-Za-z0-9_-]{20,}'
)

scan() {
  local pattern="$1" label="$2"
  local hits
  hits=$(grep -rInE --binary-files=without-match \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist \
    --exclude='bun.lock' --exclude='.private-denylist' \
    -- "$pattern" "$ROOT" 2>/dev/null) || return 0
  if [ -n "$hits" ]; then
    printf '%s\n' "FAIL [$label]" "$hits" ""
    STATUS=1
  fi
}

for p in "${GENERIC[@]}"; do scan "$p" "generic"; done

DENY="$ROOT/.private-denylist"
if [ -f "$DENY" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    scan "$line" "denylist"
  done < "$DENY"
fi

if [ "$STATUS" -ne 0 ]; then
  echo "check-private: leaks found. Fix the CONTENT — do not add the string to a denylist." >&2
else
  echo "check-private: clean"
fi
exit "$STATUS"
```

- [ ] **Step 6: Make it executable and run the tests**

```bash
chmod +x scripts/check-private.sh
bun install
bun test tests/check-private.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 7: Create the `Makefile`**

`UID`/`GID` are exported here because Docker Compose does not provide them.

```makefile
export UID := $(shell id -u)
export GID := $(shell id -g)

.PHONY: dev types check check-clean test build up down logs restart

dev:
	bun run dev:server & bun run dev:web; kill %1

types:
	bun run scripts/gen-herdr-types.ts

check:
	bunx tsc --noEmit

check-clean:
	bash scripts/check-private.sh .

test:
	bun test

build: check check-clean test
	bun run build:web
	bun build --compile --target=bun src/server/index.ts --outfile paddock

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

restart:
	docker compose restart
```

- [ ] **Step 8: Verify the gates run**

```bash
make check-clean
make test
```

Expected: `check-private: clean`, and 6 passing tests.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json Makefile scripts/check-private.sh tests/check-private.test.ts bun.lock
git commit -m "feat: repo scaffold and public-repo leak scanner"
```

---

## Task 2: Probe blocked-agent detection output

**A spike. Output is a documented finding, not code.** It shapes the future v2 interaction plan and does not block Tasks 3–16 — run it early, but proceed if a blocked agent is not available yet.

**Files:**
- Modify: `docs/herdr-socket-api.md` (create if absent)
- Modify: `docs/design/2026-08-17-paddock-design.md` §14 question 1 — record the answer

**Interfaces:**
- Consumes: nothing
- Produces: a documented decision on whether tap-to-answer is feasible in the future v2 plan

- [ ] **Step 1: Manufacture a blocked agent**

In a herdr pane, start a coding agent and give it a task that triggers a permission prompt (for example, asking it to run a command it must ask about). Confirm state with:

```bash
herdr agent list | python3 -c "import sys,json; \
print([(a['name'],a['agent_status']) for a in json.load(sys.stdin)['result']['agents']])"
```

Expected: one agent shows `blocked`.

- [ ] **Step 2: Capture the detection snapshot**

```bash
herdr agent read <name> --source detection --lines 40 --format text
```

- [ ] **Step 3: Capture the other three sources for comparison**

```bash
for s in visible recent recent-unwrapped; do
  echo "=== $s ==="
  herdr agent read <name> --source "$s" --lines 40 --format text
done
```

- [ ] **Step 4: Answer three questions in writing**

Append to `docs/herdr-socket-api.md`:

1. Does any source contain the prompt's option list as parseable text?
2. Are options consistently numbered/prefixed, or is selection purely positional (arrow keys)?
3. Is the question text separable from surrounding output?

- [ ] **Step 5: Record the decision in the spec**

Replace §14 question 1 with the finding and one of:

- **Parseable** → v2 renders real option buttons as designed.
- **Not parseable** → v2 ships the free-text reply box as the primary path; tap-to-answer is dropped. Note this in `docs/roadmap.md`.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add docs/herdr-socket-api.md docs/design/2026-08-17-paddock-design.md
git commit -m "docs: record blocked-agent detection snapshot findings"
```

---

## Task 3: Generated herdr types and the protocol guard

**Files:**
- Create: `scripts/gen-herdr-types.ts`, `src/shared/herdr-api.d.ts` (generated, committed)
- Test: `tests/herdr-protocol.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `HERDR_PROTOCOL: 19` and `HerdrAgentRaw` from `@shared/herdr-api`

- [ ] **Step 1: Write the failing test**

Create `tests/herdr-protocol.test.ts`:

```ts
import { expect, test } from "bun:test";
import { HERDR_PROTOCOL } from "@shared/herdr-api";

test("pinned protocol matches the installed herdr schema", async () => {
  const proc = Bun.spawn(["herdr", "api", "schema", "--json"], { stdout: "pipe" });
  const schema = JSON.parse(await new Response(proc.stdout).text());
  expect(schema.protocol).toBe(HERDR_PROTOCOL);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/herdr-protocol.test.ts`
Expected: FAIL — cannot resolve `@shared/herdr-api`.

- [ ] **Step 3: Write the generator**

Create `scripts/gen-herdr-types.ts`:

```ts
// Generates src/shared/herdr-api.d.ts from the installed herdr's own schema.
// Run via `make types`. Never hand-edit the output.
const proc = Bun.spawn(["herdr", "api", "schema", "--json"], { stdout: "pipe", stderr: "pipe" });
const raw = await new Response(proc.stdout).text();
if ((await proc.exited) !== 0) {
  throw new Error(`herdr api schema failed: ${await new Response(proc.stderr).text()}`);
}
const schema = JSON.parse(raw);

const protocol: number = schema.protocol;
const states: string[] =
  schema.schemas.subscription_event.$defs.AgentStatus.enum;

const out = `// GENERATED by scripts/gen-herdr-types.ts — do not edit.
// Source: \`herdr api schema --json\`, protocol ${protocol}.

export const HERDR_PROTOCOL = ${protocol} as const;

export type HerdrAgentStatus = ${states.map((s) => `"${s}"`).join(" | ")};

/** One entry from \`agent.list\` -> result.agents[]. */
export interface HerdrAgentRaw {
  agent?: string | null;
  agent_status: HerdrAgentStatus;
  cwd: string;
  foreground_cwd?: string;
  focused: boolean;
  name?: string | null;
  pane_id: string;
  revision: number;
  state_change_seq?: number;
  tab_id: string;
  terminal_id: string;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  workspace_id: string;
}

/** One entry from \`workspace.list\` -> result.workspaces[]. */
export interface HerdrWorkspaceRaw {
  workspace_id: string;
  label?: string | null;
  number: number;
}

/** Payload of the \`pane.agent_status_changed\` subscription event. */
export interface HerdrStatusChanged {
  pane_id: string;
  workspace_id: string;
  agent_status: HerdrAgentStatus;
  agent?: string | null;
  display_agent?: string | null;
  title?: string | null;
  state_labels?: Record<string, string>;
}

export interface HerdrRequest { id: string; method: string; params: object }
export type HerdrResponse =
  | { id: string; result: Record<string, unknown> }
  | { id: string; error: { message?: string; code?: string } };
export interface HerdrEvent { event: string; data: Record<string, unknown> }
`;

await Bun.write("src/shared/herdr-api.d.ts", out);
console.log(`wrote src/shared/herdr-api.d.ts (protocol ${protocol}, ${states.length} states)`);
```

- [ ] **Step 4: Generate and run the test**

```bash
make types
bun test tests/herdr-protocol.test.ts
```

Expected: generator prints `protocol 19, 5 states`; test PASSES.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add scripts/gen-herdr-types.ts src/shared/herdr-api.d.ts tests/herdr-protocol.test.ts
git commit -m "feat: generate herdr API types from the installed schema"
```

---

## Task 4: NDJSON unix socket client

**Files:**
- Create: `src/server/herdr/socket.ts`
- Test: `tests/socket.test.ts`

**herdr closes a connection after one response.** This task's shape follows from
that (see "Verified herdr socket facts"). There is no long-lived request
connection and no `id`→promise map: `request()` opens a connection, sends one
frame, reads one response, and lets the server close it. Only `events.subscribe`
holds a connection open, and nothing else may be sent on it.

**Interfaces:**
- Consumes: `HERDR_PROTOCOL`, `HerdrEvent` from `@shared/herdr-api`
- Produces:
  - `function request<T>(path: string, method: string, params?: object): Promise<T>`
  - `function checkProtocol(path: string): Promise<void>` — throws `ProtocolMismatchError`
  - `interface Subscription { type: string; pane_id?: string }`
  - `function statusSubscriptions(paneIds: string[]): Subscription[]`
  - `const GLOBAL_SUBSCRIPTIONS: Subscription[]`
  - `class HerdrStream`
  - `new HerdrStream(opts: { path: string; onEvent: (e: HerdrEvent) => void; onStateChange?: (connected: boolean) => void })`
  - `open(subs: Subscription[]): Promise<void>` — closes any existing stream first
  - `close(): void`, `get connected(): boolean`
  - `class ProtocolMismatchError extends Error { expected: number; actual: number }`
  - Event-name constants: `EVENT_STATUS_CHANGED`, `EVENT_AGENT_DETECTED`, `EVENT_PANE_CLOSED`, `EVENT_PANE_EXITED`

- [ ] **Step 1: Write the failing test**

Create `tests/socket.test.ts`.

The fake herdr below **closes the connection after every response**, and refuses
a second request on the same connection, because that is what herdr 0.8.0 does.
A fake that keeps the connection open would let a multiplexing client pass its
tests and then fail against the real socket — which is exactly how the original
design of this task went wrong.

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HerdrStream,
  ProtocolMismatchError,
  checkProtocol,
  request,
  statusSubscriptions,
  GLOBAL_SUBSCRIPTIONS,
  EVENT_STATUS_CHANGED,
  EVENT_PANE_CLOSED,
} from "@server/herdr/socket";
import type { HerdrEvent } from "@shared/herdr-api";

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

/**
 * Models herdr's real connection behaviour:
 *  - a request connection gets ONE response, then the server closes it
 *  - an events.subscribe connection stays open and streams
 */
async function fakeHerdr(protocol = 19) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-sock-"));
  const path = join(dir, "h.sock");
  const streams = new Set<any>();
  const served = new WeakSet<any>();
  const requestsSeen: { method: string; params: any }[] = [];

  const server = Bun.listen({
    unix: path,
    socket: {
      close(s) { streams.delete(s); },
      data(s, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);

          // A connection that already answered must not answer again.
          if (served.has(s)) { s.end(); return; }
          requestsSeen.push({ method: req.method, params: req.params });

          if (req.method === "events.subscribe") {
            s.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
            streams.add(s); // stays open
            return;
          }

          const reply =
            req.method === "ping"
              ? { id: req.id, result: { type: "pong", version: "0.8.0", protocol } }
              : req.method === "boom"
                ? { id: req.id, error: { code: "invalid_request", message: "no such thing" } }
                : { id: req.id, result: { type: "agent_list", agents: [] } };
          s.write(JSON.stringify(reply) + "\n");
          served.add(s);
          s.end(); // herdr closes after one response
        }
      },
    },
  });

  stop = () => { for (const s of streams) s.end(); server.stop(true); };
  return {
    path,
    requestsSeen,
    push: (e: HerdrEvent) => { for (const s of streams) s.write(JSON.stringify(e) + "\n"); },
    pushRaw: (text: string) => { for (const s of streams) s.write(text); },
    streamCount: () => streams.size,
  };
}

test("a request returns its result", async () => {
  const { path } = await fakeHerdr();
  const res = await request<{ type: string }>(path, "agent.list", {});
  expect(res.type).toBe("agent_list");
});

// THE regression test for this task. The server hangs up after each response,
// so every request must open its own connection. A multiplexing client passes
// the test above and fails this one.
test("sequential requests each open a fresh connection", async () => {
  const { path } = await fakeHerdr();
  expect((await request<{ type: string }>(path, "agent.list", {})).type).toBe("agent_list");
  expect((await request<{ type: string }>(path, "workspace.list", {})).type).toBe("agent_list");
  expect((await request<{ type: string }>(path, "agent.list", {})).type).toBe("agent_list");
});

test("a request rejects when herdr returns an error body", async () => {
  const { path } = await fakeHerdr();
  await expect(request(path, "boom", {})).rejects.toThrow("no such thing");
});

test("checkProtocol accepts a matching protocol", async () => {
  const { path } = await fakeHerdr(19);
  await checkProtocol(path);
});

test("checkProtocol throws ProtocolMismatchError on a different protocol", async () => {
  const { path } = await fakeHerdr(20);
  await expect(checkProtocol(path)).rejects.toBeInstanceOf(ProtocolMismatchError);
});

test("status subscriptions carry a pane_id; global ones do not", () => {
  const subs = statusSubscriptions(["w1:p1", "w1:p2"]);
  expect(subs).toEqual([
    { type: "pane.agent_status_changed", pane_id: "w1:p1" },
    { type: "pane.agent_status_changed", pane_id: "w1:p2" },
  ]);
  for (const g of GLOBAL_SUBSCRIPTIONS) expect(g.pane_id).toBeUndefined();
});

test("the stream sends every subscription in one events.subscribe call", async () => {
  const { path, requestsSeen } = await fakeHerdr();
  const stream = new HerdrStream({ path, onEvent: () => {} });
  await stream.open([...statusSubscriptions(["w1:p1"]), ...GLOBAL_SUBSCRIPTIONS]);
  const sub = requestsSeen.find((r) => r.method === "events.subscribe");
  expect(sub!.params.subscriptions).toHaveLength(1 + GLOBAL_SUBSCRIPTIONS.length);
  stream.close();
});

test("the stream delivers events, keeping herdr's own event names", async () => {
  const { path, push } = await fakeHerdr();
  const seen: HerdrEvent[] = [];
  const stream = new HerdrStream({ path, onEvent: (e) => seen.push(e) });
  await stream.open(statusSubscriptions(["w1:p1"]));

  // Dotted for a SubscriptionEventKind, underscored for the rest.
  push({ event: EVENT_STATUS_CHANGED, data: { pane_id: "w1:p1", agent_status: "working" } } as HerdrEvent);
  push({ event: EVENT_PANE_CLOSED, data: { pane_id: "w1:p1", workspace_id: "w1" } } as HerdrEvent);
  await Bun.sleep(50);

  expect(seen.map((e) => e.event)).toEqual([EVENT_STATUS_CHANGED, EVENT_PANE_CLOSED]);
  stream.close();
});

test("the stream reassembles a frame split across two writes", async () => {
  const { path, pushRaw } = await fakeHerdr();
  const seen: HerdrEvent[] = [];
  const stream = new HerdrStream({ path, onEvent: (e) => seen.push(e) });
  await stream.open(statusSubscriptions(["w1:p1"]));

  const frame =
    JSON.stringify({ event: EVENT_STATUS_CHANGED, data: { pane_id: "w1:p1", agent_status: "blocked" } }) + "\n";
  const cut = Math.floor(frame.length / 2);
  pushRaw(frame.slice(0, cut));
  await Bun.sleep(20);
  expect(seen).toHaveLength(0); // nothing dispatched until the newline arrives
  pushRaw(frame.slice(cut));
  await Bun.sleep(30);

  expect(seen).toHaveLength(1);
  expect((seen[0]!.data as any).agent_status).toBe("blocked");
  stream.close();
});

test("two frames arriving in one write are both dispatched", async () => {
  const { path, pushRaw } = await fakeHerdr();
  const seen: HerdrEvent[] = [];
  const stream = new HerdrStream({ path, onEvent: (e) => seen.push(e) });
  await stream.open(statusSubscriptions(["w1:p1"]));

  pushRaw(
    JSON.stringify({ event: EVENT_STATUS_CHANGED, data: { pane_id: "w1:p1" } }) + "\n" +
    JSON.stringify({ event: EVENT_PANE_CLOSED, data: { pane_id: "w1:p2" } }) + "\n",
  );
  await Bun.sleep(50);

  expect(seen.map((e) => e.event)).toEqual([EVENT_STATUS_CHANGED, EVENT_PANE_CLOSED]);
  stream.close();
});

test("open() replaces the previous stream rather than stacking one", async () => {
  const { path, streamCount } = await fakeHerdr();
  const stream = new HerdrStream({ path, onEvent: () => {} });
  await stream.open(statusSubscriptions(["w1:p1"]));
  await stream.open(statusSubscriptions(["w1:p1", "w1:p2"]));
  await Bun.sleep(50);
  expect(streamCount()).toBe(1);
  stream.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/socket.test.ts`
Expected: FAIL — cannot resolve `@server/herdr/socket`.

- [ ] **Step 3: Implement the socket client**

Create `src/server/herdr/socket.ts`:

```ts
import { HERDR_PROTOCOL, type HerdrEvent } from "@shared/herdr-api";

export class ProtocolMismatchError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(
      `herdr protocol mismatch: paddock expects ${expected}, herdr reports ${actual}. ` +
        `Run \`make types\` and re-check src/server/herdr/adapter.ts before continuing.`,
    );
    this.name = "ProtocolMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Wire names.
//
// The name you SUBSCRIBE with is not always the name herdr DELIVERS. The three
// SubscriptionEventKind types keep their dotted names; every other subscribable
// type is delivered with underscores. Matching on the subscribe name for those
// silently never fires, so both spellings are pinned here as named constants
// rather than written inline at call sites.
// ---------------------------------------------------------------------------

/** Delivered names — match incoming events against these. */
export const EVENT_STATUS_CHANGED = "pane.agent_status_changed"; // dotted
export const EVENT_AGENT_DETECTED = "pane_agent_detected";       // underscored
export const EVENT_PANE_CLOSED = "pane_closed";                  // underscored
export const EVENT_PANE_EXITED = "pane_exited";                  // underscored

/** Subscribe names — send these in events.subscribe. */
const SUB_STATUS_CHANGED = "pane.agent_status_changed";
const SUB_AGENT_DETECTED = "pane.agent_detected";
const SUB_PANE_CLOSED = "pane.closed";
const SUB_PANE_EXITED = "pane.exited";

export interface Subscription {
  type: string;
  pane_id?: string;
}

/** pane.agent_status_changed has no global form — each pane must be named. */
export function statusSubscriptions(paneIds: string[]): Subscription[] {
  return paneIds.map((pane_id) => ({ type: SUB_STATUS_CHANGED, pane_id }));
}

/** These take no pane_id. They are how paddock learns the pane set changed. */
export const GLOBAL_SUBSCRIPTIONS: Subscription[] = [
  { type: SUB_AGENT_DETECTED },
  { type: SUB_PANE_CLOSED },
  { type: SUB_PANE_EXITED },
];

// ---------------------------------------------------------------------------
// Requests: one connection, one request, one response. herdr hangs up after
// the response, so there is nothing to pool, reuse, or correlate by id.
// ---------------------------------------------------------------------------

export function request<T>(path: string, method: string, params: object = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write(JSON.stringify({ id: "paddock", method, params }) + "\n");
        },
        data(socket, chunk) {
          buffer += chunk.toString();
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          const line = buffer.slice(0, newline);
          socket.end();
          let frame: any;
          try {
            frame = JSON.parse(line);
          } catch (err) {
            finish(() => reject(new Error(`herdr sent an unparseable frame for ${method}: ${err}`)));
            return;
          }
          if (frame.error) {
            const { code, message } = frame.error;
            finish(() => reject(new Error(`herdr ${method} failed [${code}]: ${message}`)));
            return;
          }
          finish(() => resolve(frame.result as T));
        },
        close() {
          finish(() => reject(new Error(`herdr closed the connection before answering ${method}`)));
        },
        error(_socket, err) {
          finish(() => reject(err));
        },
      },
    }).catch((err) => finish(() => reject(err)));
  });
}

export async function checkProtocol(path: string): Promise<void> {
  const pong = await request<{ protocol: number }>(path, "ping", {});
  if (pong.protocol !== HERDR_PROTOCOL) {
    throw new ProtocolMismatchError(HERDR_PROTOCOL, pong.protocol);
  }
}

// ---------------------------------------------------------------------------
// The event stream: the one connection that stays open. Nothing else may be
// sent on it — herdr closes it if anything is.
// ---------------------------------------------------------------------------

export interface HerdrStreamOptions {
  path: string;
  onEvent: (e: HerdrEvent) => void;
  onStateChange?: (connected: boolean) => void;
}

export class HerdrStream {
  private socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  private buffer = "";
  private wantOpen = false;

  constructor(private readonly opts: HerdrStreamOptions) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  /**
   * Open a stream carrying `subs`. Any existing stream is closed first: a
   * subscription set cannot be extended after the fact, so changing it means
   * replacing the connection.
   */
  async open(subs: Subscription[]): Promise<void> {
    this.close();
    this.wantOpen = true;
    this.buffer = "";

    const socket = await Bun.connect({
      unix: this.opts.path,
      socket: {
        data: (_s, chunk) => this.onData(chunk.toString()),
        close: () => {
          this.socket = null;
          this.opts.onStateChange?.(false);
          if (this.wantOpen) console.error("herdr: event stream closed unexpectedly");
        },
        error: (_s, err) => console.error("herdr: event stream error", err),
      },
    });

    socket.write(JSON.stringify({
      id: "paddock-sub",
      method: "events.subscribe",
      params: { subscriptions: subs },
    }) + "\n");

    this.socket = socket;
    this.opts.onStateChange?.(true);
  }

  close(): void {
    this.wantOpen = false;
    this.socket?.end();
    this.socket = null;
  }

  // A frame may arrive split across chunks, or several frames in one chunk.
  // Keep the trailing partial line in the buffer.
  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        console.error("herdr: unparseable frame", { bytes: line.length, err });
        continue;
      }
      // The subscribe acknowledgement carries an id; events do not.
      if (typeof frame.id === "string") {
        if (frame.error) {
          console.error("herdr: events.subscribe was rejected", frame.error);
        }
        continue;
      }
      if (typeof frame.event === "string") this.opts.onEvent(frame as HerdrEvent);
      else console.error("herdr: frame with neither id nor event", frame);
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/socket.test.ts`
Expected: 11 PASS.

- [ ] **Step 5: Verify against the real herdr, not just the fake**

The fake encodes what we believe herdr does. Confirm it on the live socket
before building four more tasks on top:

```bash
bun -e '
import { request, checkProtocol } from "./src/server/herdr/socket.ts";
const p = `${process.env.HOME}/.config/herdr/herdr.sock`;
await checkProtocol(p);
const a = await request(p, "agent.list", {});
const w = await request(p, "workspace.list", {});
console.log("protocol ok; agents:", a.agents.length, "workspaces:", w.workspaces.length);
'
```

Expected: prints counts without error. Three sequential requests over three
connections is exactly the pattern the old design got wrong, so this is the
step that proves the fix.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean
git add src/server/herdr/socket.ts tests/socket.test.ts
git commit -m "feat: herdr socket client with per-request connections and an event stream"
```

---

## Task 5: Adapter — the fix for identical rows

The regression test here is the whole reason paddock exists.

**Files:**
- Create: `src/shared/types.ts`, `src/server/herdr/adapter.ts`
- Test: `tests/adapter.test.ts`

**Interfaces:**
- Consumes: `HerdrAgentRaw`, `HerdrWorkspaceRaw`, `HerdrStatusChanged`
- Produces:
  - `type AgentState = "blocked" | "done" | "working" | "idle"`
  - `interface Agent { hostId; agentId; name; task; state; workspaceId; workspaceLabel; cwd; stateSince; updatedAt }`
  - `type ServerMessage`
  - `toAgent(raw, ctx: { hostId: string; labels: Map<string,string>; now: number }): Agent | null`
  - `applyStatusEvent(prev: Agent, data: HerdrStatusChanged, now: number): Agent`

- [ ] **Step 1: Write `src/shared/types.ts`**

```ts
export type AgentState = "blocked" | "done" | "working" | "idle";

export interface Agent {
  hostId: string;
  agentId: string;
  /** Operator-assigned name. The PRIMARY label. Never derived from cwd. */
  name: string;
  /** Live task line, from terminal_title_stripped. */
  task: string;
  state: AgentState;
  workspaceId: string;
  workspaceLabel: string | null;
  cwd: string;
  /** Epoch ms when this state was first observed. Stamped by paddock. */
  stateSince: number;
  updatedAt: number;
}

export type ServerMessage =
  | { type: "snapshot"; hostId: string; agents: Agent[]; serverTime: number }
  | { type: "delta"; upserted: Agent[]; removedIds: string[]; serverTime: number };

export const SECTION_ORDER = ["needs-you", "working", "idle"] as const;
export type Section = (typeof SECTION_ORDER)[number];

export function sectionFor(state: AgentState): Section {
  if (state === "blocked" || state === "done") return "needs-you";
  if (state === "working") return "working";
  return "idle";
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/adapter.test.ts`:

```ts
import { expect, test } from "bun:test";
import { applyStatusEvent, toAgent } from "@server/herdr/adapter";
import type { HerdrAgentRaw } from "@shared/herdr-api";

const NOW = 1_700_000_000_000;
const ctx = { hostId: "dev-box", labels: new Map([["w1", "api work"]]), now: NOW };

function raw(over: Partial<HerdrAgentRaw> = {}): HerdrAgentRaw {
  return {
    agent: "claude",
    agent_status: "working",
    cwd: "/srv/project",
    focused: false,
    name: "api-refactor",
    pane_id: "w1:p1",
    revision: 1,
    tab_id: "w1:t1",
    terminal_id: "t1",
    terminal_title: "* Extract auth middleware",
    terminal_title_stripped: "Extract auth middleware",
    workspace_id: "w1",
    ...over,
  };
}

test("uses name as the label and terminal_title_stripped as the task", () => {
  const a = toAgent(raw(), ctx)!;
  expect(a.name).toBe("api-refactor");
  expect(a.task).toBe("Extract auth middleware");
});

test("REGRESSION: agents sharing a cwd get distinct labels", () => {
  const a = toAgent(raw({ pane_id: "w1:p1", name: "api-refactor" }), ctx)!;
  const b = toAgent(raw({ pane_id: "w2:p1", name: "flaky-test-fix" }), ctx)!;
  expect(a.cwd).toBe(b.cwd);
  expect(a.name).not.toBe(b.name);
  expect(a.name).not.toBe("project"); // never basename(cwd)
});

test("falls back to the pane id when name is missing, never to cwd", () => {
  const a = toAgent(raw({ name: null }), ctx)!;
  expect(a.name).toBe("w1:p1");
  expect(a.name).not.toBe("project");
});

test("filters out panes with status unknown", () => {
  expect(toAgent(raw({ agent_status: "unknown" }), ctx)).toBeNull();
});

test("filters out panes with no agent field", () => {
  expect(toAgent(raw({ agent: null }), ctx)).toBeNull();
});

test("joins the workspace label by workspace_id", () => {
  expect(toAgent(raw(), ctx)!.workspaceLabel).toBe("api work");
  expect(toAgent(raw({ workspace_id: "w9" }), ctx)!.workspaceLabel).toBeNull();
});

test("stamps stateSince from the supplied clock", () => {
  expect(toAgent(raw(), ctx)!.stateSince).toBe(NOW);
});

test("a status event preserves name and refreshes stateSince only on change", () => {
  const prev = toAgent(raw(), ctx)!;
  const same = applyStatusEvent(prev, { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working" }, NOW + 5000);
  expect(same.name).toBe("api-refactor");
  expect(same.stateSince).toBe(NOW);

  const moved = applyStatusEvent(prev, { pane_id: "w1:p1", workspace_id: "w1", agent_status: "blocked" }, NOW + 5000);
  expect(moved.state).toBe("blocked");
  expect(moved.stateSince).toBe(NOW + 5000);
});

test("a status event updates the task when it carries a title", () => {
  const prev = toAgent(raw(), ctx)!;
  const next = applyStatusEvent(
    prev,
    { pane_id: "w1:p1", workspace_id: "w1", agent_status: "working", title: "* Rename the module" },
    NOW + 1,
  );
  expect(next.task).toBe("Rename the module");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/adapter.test.ts`
Expected: FAIL — cannot resolve `@server/herdr/adapter`.

- [ ] **Step 4: Implement the adapter**

Create `src/server/herdr/adapter.ts`:

```ts
import type { Agent, AgentState } from "@shared/types";
import type { HerdrAgentRaw, HerdrStatusChanged, HerdrWorkspaceRaw } from "@shared/herdr-api";

export interface AdaptContext {
  hostId: string;
  labels: Map<string, string>;
  now: number;
}

/** Leading status glyphs some agents prepend to the terminal title. */
function cleanTitle(title: string | null | undefined): string {
  return (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function toState(status: string): AgentState | null {
  if (status === "blocked" || status === "done" || status === "working" || status === "idle") {
    return status;
  }
  return null; // "unknown" and anything new
}

export function workspaceLabels(rows: HerdrWorkspaceRaw[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const w of rows) if (w.label) map.set(w.workspace_id, w.label);
  return map;
}

/**
 * Normalize one `agent.list` row. Returns null for anything that is not an agent.
 *
 * `name` is the label. NEVER basename(cwd): agents commonly share a working
 * directory, which is exactly how every row ends up looking identical.
 */
export function toAgent(rawAgent: HerdrAgentRaw, ctx: AdaptContext): Agent | null {
  if (!rawAgent.agent) return null;
  const state = toState(rawAgent.agent_status);
  if (!state) return null;

  return {
    hostId: ctx.hostId,
    agentId: rawAgent.pane_id,
    name: rawAgent.name?.trim() || rawAgent.pane_id,
    task: cleanTitle(rawAgent.terminal_title_stripped ?? rawAgent.terminal_title),
    state,
    workspaceId: rawAgent.workspace_id,
    workspaceLabel: ctx.labels.get(rawAgent.workspace_id) ?? null,
    cwd: rawAgent.cwd,
    stateSince: ctx.now,
    updatedAt: ctx.now,
  };
}

/**
 * Merge a `pane.agent_status_changed` event into a known agent.
 *
 * The event carries no `name`, so the previous value is preserved. `stateSince`
 * is refreshed only when the state actually changes, so elapsed time means
 * "how long in this state" rather than "time since last event".
 */
export function applyStatusEvent(prev: Agent, data: HerdrStatusChanged, now: number): Agent {
  const state = toState(data.agent_status) ?? prev.state;
  const title = data.title === undefined || data.title === null ? prev.task : cleanTitle(data.title);
  return {
    ...prev,
    state,
    task: title,
    stateSince: state === prev.state ? prev.stateSince : now,
    updatedAt: now,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/adapter.test.ts`
Expected: 9 PASS.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean
git add src/shared/types.ts src/server/herdr/adapter.ts tests/adapter.test.ts
git commit -m "feat: adapter mapping name/task, with regression test for shared cwd"
```

---

## Task 6: State store and delta computation

**Files:**
- Create: `src/server/state/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `Agent` from `@shared/types`
- Produces:
  - `class AgentStore`
  - `new AgentStore(hostId: string)`
  - `replaceAll(agents: Agent[], now: number): { upserted: Agent[]; removedIds: string[] }`
  - `applyEvent(agentId: string, mutate: (prev: Agent) => Agent): Agent | null`
  - `snapshot(): Agent[]` — sorted for display
  - `has(agentId: string): boolean`
  - `remove(agentId: string): Delta | null` — for `pane_closed` / `pane_exited`

- [ ] **Step 1: Write the failing test**

Create `tests/store.test.ts`:

```ts
import { expect, test } from "bun:test";
import { AgentStore } from "@server/state/store";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box",
    agentId: "w1:p1",
    name: "api-refactor",
    task: "Extract auth middleware",
    state: "working",
    workspaceId: "w1",
    workspaceLabel: null,
    cwd: "/srv/project",
    stateSince: NOW,
    updatedAt: NOW,
    ...over,
  };
}

test("replaceAll reports newly added agents as upserted", () => {
  const store = new AgentStore("dev-box");
  const d = store.replaceAll([agent()], NOW);
  expect(d.upserted).toHaveLength(1);
  expect(d.removedIds).toEqual([]);
});

test("replaceAll reports no upserts when nothing changed", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const d = store.replaceAll([agent()], NOW + 1000);
  expect(d.upserted).toEqual([]);
});

test("replaceAll preserves the original stateSince for an unchanged state", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  store.replaceAll([agent({ stateSince: NOW + 9000 })], NOW + 9000);
  expect(store.snapshot()[0]!.stateSince).toBe(NOW);
});

test("replaceAll reports a state change as an upsert and restamps stateSince", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const d = store.replaceAll([agent({ state: "blocked", stateSince: NOW + 2000 })], NOW + 2000);
  expect(d.upserted).toHaveLength(1);
  expect(d.upserted[0]!.stateSince).toBe(NOW + 2000);
});

test("replaceAll reports disappeared agents as removed", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent(), agent({ agentId: "w2:p1", name: "docs-cleanup" })], NOW);
  const d = store.replaceAll([agent()], NOW + 1000);
  expect(d.removedIds).toEqual(["w2:p1"]);
});

test("applyEvent mutates a known agent and returns it", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const out = store.applyEvent("w1:p1", (p) => ({ ...p, state: "blocked" }));
  expect(out!.state).toBe("blocked");
});

test("applyEvent returns null for an unknown agent", () => {
  const store = new AgentStore("dev-box");
  expect(store.applyEvent("nope:p1", (p) => p)).toBeNull();
});

test("remove drops the agent and reports it as removed", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const d = store.remove("w1:p1");
  expect(d!.removedIds).toEqual(["w1:p1"]);
  expect(store.snapshot()).toEqual([]);
});

test("removing an already-gone agent returns null, so no empty delta is sent", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  store.remove("w1:p1");
  expect(store.remove("w1:p1")).toBeNull();
});

test("snapshot sorts needs-you first, then working, then idle", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll(
    [
      agent({ agentId: "a", name: "idle-one", state: "idle" }),
      agent({ agentId: "b", name: "working-one", state: "working" }),
      agent({ agentId: "c", name: "blocked-one", state: "blocked" }),
    ],
    NOW,
  );
  expect(store.snapshot().map((a) => a.name)).toEqual(["blocked-one", "working-one", "idle-one"]);
});

test("snapshot orders needs-you by most recent state change first", () => {
  const store = new AgentStore("dev-box");
  store.replaceAll(
    [
      agent({ agentId: "a", name: "older", state: "blocked", stateSince: NOW }),
      agent({ agentId: "b", name: "newer", state: "done", stateSince: NOW + 5000 }),
    ],
    NOW,
  );
  expect(store.snapshot().map((a) => a.name)).toEqual(["newer", "older"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/store.test.ts`
Expected: FAIL — cannot resolve `@server/state/store`.

- [ ] **Step 3: Implement the store**

Create `src/server/state/store.ts`:

```ts
import { SECTION_ORDER, sectionFor, type Agent } from "@shared/types";

export interface Delta {
  upserted: Agent[];
  removedIds: string[];
}

/** Fields whose change is worth sending to a browser. */
function differs(a: Agent, b: Agent): boolean {
  return (
    a.name !== b.name ||
    a.task !== b.task ||
    a.state !== b.state ||
    a.workspaceLabel !== b.workspaceLabel ||
    a.cwd !== b.cwd
  );
}

export class AgentStore {
  private readonly agents = new Map<string, Agent>();

  constructor(readonly hostId: string) {}

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Drop one agent, for a pane_closed / pane_exited event. Returns null when
   * the agent was already gone, so a duplicate event does not emit an empty
   * delta to every browser.
   */
  remove(agentId: string): Delta | null {
    if (!this.agents.delete(agentId)) return null;
    return { upserted: [], removedIds: [agentId] };
  }

  /**
   * Reconcile against a full listing. `stateSince` from the incoming rows is
   * only adopted when the state actually changed, so a reconcile never resets
   * elapsed time for an agent that has been sitting in one state.
   */
  replaceAll(incoming: Agent[], now: number): Delta {
    const upserted: Agent[] = [];
    const seen = new Set<string>();

    for (const next of incoming) {
      seen.add(next.agentId);
      const prev = this.agents.get(next.agentId);
      if (!prev) {
        this.agents.set(next.agentId, next);
        upserted.push(next);
        continue;
      }
      const merged: Agent = {
        ...next,
        stateSince: next.state === prev.state ? prev.stateSince : now,
        updatedAt: now,
      };
      this.agents.set(next.agentId, merged);
      if (differs(prev, merged)) upserted.push(merged);
    }

    const removedIds: string[] = [];
    for (const id of this.agents.keys()) {
      if (!seen.has(id)) removedIds.push(id);
    }
    for (const id of removedIds) this.agents.delete(id);

    return { upserted, removedIds };
  }

  applyEvent(agentId: string, mutate: (prev: Agent) => Agent): Agent | null {
    const prev = this.agents.get(agentId);
    if (!prev) return null;
    const next = mutate(prev);
    this.agents.set(agentId, next);
    return next;
  }

  /** Display order: section, then most-recent state change, then name. */
  snapshot(): Agent[] {
    return [...this.agents.values()].sort((a, b) => {
      const sa = SECTION_ORDER.indexOf(sectionFor(a.state));
      const sb = SECTION_ORDER.indexOf(sectionFor(b.state));
      if (sa !== sb) return sa - sb;
      if (a.stateSince !== b.stateSince) return b.stateSince - a.stateSince;
      return a.name.localeCompare(b.name);
    });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/store.test.ts`
Expected: 11 PASS.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/state/store.ts tests/store.test.ts
git commit -m "feat: agent store with delta computation and triage ordering"
```

---

## Task 7: WebSocket hub with burst coalescing

**Files:**
- Create: `src/server/ws/hub.ts`
- Test: `tests/hub.test.ts`

**Interfaces:**
- Consumes: `Agent`, `ServerMessage` from `@shared/types`
- Produces:
  - `class Hub`
  - `new Hub(opts: { coalesceMs?: number; now?: () => number })`
  - `add(client: HubClient): void` / `remove(client: HubClient): void`
  - `sendSnapshot(client: HubClient, hostId: string, agents: Agent[]): void`
  - `queue(delta: { upserted: Agent[]; removedIds: string[] }): void`
  - `flush(): void`
  - `interface HubClient { send(data: string): void }`
  - `get clientCount(): number`

- [ ] **Step 1: Write the failing test**

Create `tests/hub.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Hub, type HubClient } from "@server/ws/hub";
import type { Agent, ServerMessage } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "working", workspaceId: "w1",
    workspaceLabel: null, cwd: "/srv/project", stateSince: NOW, updatedAt: NOW, ...over,
  };
}

function fakeClient() {
  const sent: ServerMessage[] = [];
  const client: HubClient = { send: (d) => sent.push(JSON.parse(d)) };
  return { client, sent };
}

test("sendSnapshot delivers a snapshot to one client", () => {
  const hub = new Hub({ now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.sendSnapshot(client, "dev-box", [agent()]);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.type).toBe("snapshot");
});

test("queued deltas are not sent until flush", () => {
  const hub = new Hub({ coalesceMs: 100, now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.queue({ upserted: [agent()], removedIds: [] });
  expect(sent).toHaveLength(0);
  hub.flush();
  expect(sent).toHaveLength(1);
});

test("a burst for one agent coalesces to its latest value", () => {
  const hub = new Hub({ coalesceMs: 100, now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.queue({ upserted: [agent({ state: "working" })], removedIds: [] });
  hub.queue({ upserted: [agent({ state: "idle" })], removedIds: [] });
  hub.queue({ upserted: [agent({ state: "working" })], removedIds: [] });
  hub.flush();
  expect(sent).toHaveLength(1);
  const msg = sent[0]!;
  if (msg.type !== "delta") throw new Error("expected a delta");
  expect(msg.upserted).toHaveLength(1);
  expect(msg.upserted[0]!.state).toBe("working");
});

test("a removal supersedes a queued upsert for the same agent", () => {
  const hub = new Hub({ coalesceMs: 100, now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.queue({ upserted: [agent()], removedIds: [] });
  hub.queue({ upserted: [], removedIds: ["w1:p1"] });
  hub.flush();
  const msg = sent[0]!;
  if (msg.type !== "delta") throw new Error("expected a delta");
  expect(msg.upserted).toEqual([]);
  expect(msg.removedIds).toEqual(["w1:p1"]);
});

test("flush with nothing queued sends nothing", () => {
  const hub = new Hub({ now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.flush();
  expect(sent).toHaveLength(0);
});

test("a removed client receives nothing", () => {
  const hub = new Hub({ now: () => NOW });
  const { client, sent } = fakeClient();
  hub.add(client);
  hub.remove(client);
  hub.queue({ upserted: [agent()], removedIds: [] });
  hub.flush();
  expect(sent).toHaveLength(0);
  expect(hub.clientCount).toBe(0);
});

test("a delta reaches every connected client", () => {
  const hub = new Hub({ now: () => NOW });
  const a = fakeClient(); const b = fakeClient();
  hub.add(a.client); hub.add(b.client);
  hub.queue({ upserted: [agent()], removedIds: [] });
  hub.flush();
  expect(a.sent).toHaveLength(1);
  expect(b.sent).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/hub.test.ts`
Expected: FAIL — cannot resolve `@server/ws/hub`.

- [ ] **Step 3: Implement the hub**

Create `src/server/ws/hub.ts`:

```ts
import type { Agent, ServerMessage } from "@shared/types";

export interface HubClient {
  send(data: string): void;
}

export interface HubOptions {
  /** Window for merging a burst of changes into one frame. */
  coalesceMs?: number;
  now?: () => number;
}

/**
 * Browser fan-out. Knows nothing about herdr — it only forwards agents.
 *
 * Bursts are coalesced: an agent flipping working -> idle -> working within the
 * window produces one frame carrying its final value, not three.
 */
export class Hub {
  private readonly clients = new Set<HubClient>();
  private readonly pendingUpserts = new Map<string, Agent>();
  private readonly pendingRemovals = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly coalesceMs: number;
  private readonly now: () => number;

  constructor(opts: HubOptions = {}) {
    this.coalesceMs = opts.coalesceMs ?? 100;
    this.now = opts.now ?? Date.now;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  add(client: HubClient): void {
    this.clients.add(client);
  }

  remove(client: HubClient): void {
    this.clients.delete(client);
  }

  sendSnapshot(client: HubClient, hostId: string, agents: Agent[]): void {
    this.sendTo(client, { type: "snapshot", hostId, agents, serverTime: this.now() });
  }

  queue(delta: { upserted: Agent[]; removedIds: string[] }): void {
    for (const a of delta.upserted) {
      this.pendingRemovals.delete(a.agentId);
      this.pendingUpserts.set(a.agentId, a);
    }
    for (const id of delta.removedIds) {
      this.pendingUpserts.delete(id);
      this.pendingRemovals.add(id);
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.coalesceMs);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingUpserts.size === 0 && this.pendingRemovals.size === 0) return;

    const msg: ServerMessage = {
      type: "delta",
      upserted: [...this.pendingUpserts.values()],
      removedIds: [...this.pendingRemovals],
      serverTime: this.now(),
    };
    this.pendingUpserts.clear();
    this.pendingRemovals.clear();
    for (const client of this.clients) this.sendTo(client, msg);
  }

  private sendTo(client: HubClient, msg: ServerMessage): void {
    try {
      client.send(JSON.stringify(msg));
    } catch (err) {
      console.error("hub: send failed, dropping client", err);
      this.clients.delete(client);
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/hub.test.ts`
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/ws/hub.ts tests/hub.test.ts
git commit -m "feat: websocket hub with burst coalescing"
```

---

## Task 8: Demo mode

Built before the real supervisor so the UI tasks have something to render, and so screenshots never touch live data.

**Files:**
- Create: `src/server/demo.ts`
- Test: `tests/demo.test.ts`

**Interfaces:**
- Consumes: `Agent`, `AgentState`
- Produces:
  - `DEMO_HOST_ID = "demo-box"`
  - `demoAgents(now: number): Agent[]`
  - `class DemoSource { constructor(opts: { onDelta: (d: {upserted: Agent[]; removedIds: string[]}) => void; intervalMs?: number; now?: () => number }); start(): void; stop(): void; tick(): void; snapshot(): Agent[] }`

- [ ] **Step 1: Write the failing test**

Create `tests/demo.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DEMO_HOST_ID, DemoSource, demoAgents } from "@server/demo";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

// Asserted as an ALLOWLIST, not a denylist of real names. Listing real names here
// to check they are absent would commit them to a public repo — the guard would
// leak exactly what it guards.
const INVENTED_NAMES = new Set([
  "schema-migration", "lint-config", "api-refactor",
  "perf-audit", "docs-cleanup", "flaky-test-fix",
]);

test("demo data covers every displayed state", () => {
  const states = new Set(demoAgents(NOW).map((a) => a.state));
  expect(states).toEqual(new Set(["blocked", "done", "working", "idle"]));
});

test("every demo name comes from the invented fixture set", () => {
  for (const a of demoAgents(NOW)) {
    expect(INVENTED_NAMES.has(a.name)).toBe(true);
  }
});

test("demo cwd is not a real home directory", () => {
  for (const a of demoAgents(NOW)) {
    expect(a.cwd.startsWith("/" + "home/")).toBe(false);
    expect(a.cwd.startsWith("/" + "Users/")).toBe(false);
  }
});

test("demo agents all belong to the demo host", () => {
  for (const a of demoAgents(NOW)) expect(a.hostId).toBe(DEMO_HOST_ID);
});

test("tick emits a delta", () => {
  const seen: Agent[][] = [];
  const src = new DemoSource({ onDelta: (d) => seen.push(d.upserted), now: () => NOW });
  src.tick();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.length).toBeGreaterThan(0);
});

test("snapshot is stable across ticks in size", () => {
  const src = new DemoSource({ onDelta: () => {}, now: () => NOW });
  const before = src.snapshot().length;
  src.tick();
  expect(src.snapshot()).toHaveLength(before);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/demo.test.ts`
Expected: FAIL — cannot resolve `@server/demo`.

- [ ] **Step 3: Implement demo mode**

Create `src/server/demo.ts`:

```ts
import type { Agent, AgentState } from "@shared/types";

export const DEMO_HOST_ID = "demo-box";

/**
 * Synthetic agents for `--demo`. Names are INVENTED — this is the only mode used
 * for screenshots and README media, so it must never resemble real data.
 */
const SEED: Array<{ id: string; name: string; task: string; state: AgentState; ageMs: number }> = [
  { id: "d1:p1", name: "schema-migration", task: "Apply migration to staging", state: "blocked", ageMs: 120_000 },
  { id: "d2:p1", name: "lint-config", task: "Align eslint with the style guide", state: "done", ageMs: 300_000 },
  { id: "d3:p1", name: "api-refactor", task: "Extract auth middleware", state: "working", ageMs: 15_000 },
  { id: "d4:p1", name: "perf-audit", task: "Profile the request path", state: "working", ageMs: 45_000 },
  { id: "d5:p1", name: "docs-cleanup", task: "Rewrite the getting-started guide", state: "idle", ageMs: 900_000 },
  { id: "d6:p1", name: "flaky-test-fix", task: "Stabilise the upload suite", state: "idle", ageMs: 3_600_000 },
];

export function demoAgents(now: number): Agent[] {
  return SEED.map((s) => ({
    hostId: DEMO_HOST_ID,
    agentId: s.id,
    name: s.name,
    task: s.task,
    state: s.state,
    workspaceId: s.id.split(":")[0]!,
    workspaceLabel: s.name.replace(/-/g, " "),
    cwd: "/srv/demo-project",
    stateSince: now - s.ageMs,
    updatedAt: now,
  }));
}

/** Rotates one working agent's state so the UI visibly updates. */
export class DemoSource {
  private agents: Agent[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(
    private readonly opts: {
      onDelta: (d: { upserted: Agent[]; removedIds: string[] }) => void;
      intervalMs?: number;
      now?: () => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? 4000;
    this.agents = demoAgents(this.now());
  }

  snapshot(): Agent[] {
    return this.agents;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    const rotation: AgentState[] = ["working", "idle", "blocked", "working", "done"];
    const target = this.agents[this.cursor % this.agents.length]!;
    const state = rotation[this.cursor % rotation.length]!;
    const now = this.now();
    const next: Agent = { ...target, state, stateSince: now, updatedAt: now };
    this.agents = this.agents.map((a) => (a.agentId === next.agentId ? next : a));
    this.cursor += 1;
    this.opts.onDelta({ upserted: [next], removedIds: [] });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/demo.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/demo.ts tests/demo.test.ts
git commit -m "feat: demo mode with invented agent fixtures"
```

---

## Task 9: Supervisor — wire socket, adapter and store together

**Files:**
- Create: `src/server/supervisor.ts`
- Test: `tests/supervisor.test.ts`

**Interfaces:**
- Consumes: `request`, `HerdrStream`, `statusSubscriptions`, `GLOBAL_SUBSCRIPTIONS`, the `EVENT_*` constants, `toAgent`, `workspaceLabels`, `applyStatusEvent`, `AgentStore`
- Produces:
  - `class Supervisor`
  - `new Supervisor(opts: { client: HerdrClientLike; store: AgentStore; onDelta: (d: Delta) => void; reconcileMs?: number; now?: () => number })`
  - `interface HerdrClientLike { request<T>(m: string, p?: object): Promise<T>; openStream(subs: Subscription[]): Promise<void> }`

**Ordering matters here.** Status events are per-pane, so the pane set must be
known before subscribing: `reconcile()` runs **first**, then the stream opens
naming those panes plus the globals. Subscribing first would name no panes and
deliver nothing.
  - `start(): Promise<void>` / `stop(): void`
  - `reconcile(): Promise<Delta>`
  - `handleEvent(e: HerdrEvent): void`
  - `get lastEventAt(): number | null`

- [ ] **Step 1: Write the failing test**

Create `tests/supervisor.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Supervisor } from "@server/supervisor";
import { AgentStore } from "@server/state/store";
import type { Delta } from "@server/state/store";
import type { Subscription } from "@server/herdr/socket";

const NOW = 1_700_000_000_000;

function rawAgent(over: Record<string, unknown> = {}) {
  return {
    agent: "claude", agent_status: "working", cwd: "/srv/project", focused: false,
    name: "api-refactor", pane_id: "w1:p1", revision: 1, tab_id: "w1:t1",
    terminal_id: "t1", terminal_title: "* Extract auth middleware",
    terminal_title_stripped: "Extract auth middleware", workspace_id: "w1", ...over,
  };
}

function fakeClient(agents: unknown[] = [rawAgent()]) {
  const calls: string[] = [];
  return {
    calls,
    /** Every openStream call, so tests can assert the subscription set. */
    streams: [] as Subscription[][],
    async request<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "agent.list") return { type: "agent_list", agents } as T;
      if (method === "workspace.list") {
        return { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "api work", number: 1 }] } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
    async openStream(subs: Subscription[]) { this.streams.push(subs); },
  };
}

test("start reconciles FIRST, then subscribes naming every known pane", async () => {
  const client = fakeClient();
  const sup = new Supervisor({ client, store: new AgentStore("dev-box"), onDelta: () => {}, now: () => NOW });
  await sup.start();

  // Ordering: the pane set cannot be named before agent.list has returned it.
  expect(client.calls.indexOf("agent.list")).toBeGreaterThanOrEqual(0);
  expect(client.streams).toHaveLength(1);

  const subs = client.streams[0]!;
  expect(subs).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
  // Globals carry no pane_id and are how the pane set stays current.
  expect(subs).toContainEqual({ type: "pane.agent_detected" });
  expect(subs).toContainEqual({ type: "pane.closed" });
  sup.stop();
});

test("a status subscription is never sent without a pane_id", async () => {
  // herdr rejects that outright: invalid_request "missing field pane_id".
  const client = fakeClient();
  const sup = new Supervisor({ client, store: new AgentStore("dev-box"), onDelta: () => {}, now: () => NOW });
  await sup.start();
  for (const s of client.streams.flat()) {
    if (s.type === "pane.agent_status_changed") expect(s.pane_id).toBeTruthy();
  }
  sup.stop();
});

test("pane_agent_detected re-opens the stream with the new pane set", async () => {
  const client = fakeClient();
  const sup = new Supervisor({ client, store: new AgentStore("dev-box"), onDelta: () => {}, now: () => NOW });
  await sup.start();
  const before = client.streams.length;

  // Underscored — this is the name herdr actually delivers.
  sup.handleEvent({ event: "pane_agent_detected", data: { pane_id: "w1:p2", workspace_id: "w1", agent: "claude" } });
  await Bun.sleep(20);

  expect(client.streams.length).toBe(before + 1);
  sup.stop();
});

test("pane_closed removes the agent immediately, without waiting for reconcile", async () => {
  const store = new AgentStore("dev-box");
  const client = fakeClient();
  const deltas: Delta[] = [];
  const sup = new Supervisor({ client, store, onDelta: (d) => deltas.push(d), now: () => NOW });
  await sup.start();
  expect(store.snapshot()).toHaveLength(1);

  sup.handleEvent({ event: "pane_closed", data: { pane_id: "w1:p1", workspace_id: "w1" } });

  expect(store.snapshot()).toHaveLength(0);
  expect(deltas.at(-1)!.removedIds).toContain("w1:p1");
  sup.stop();
});

test("reconcile joins the workspace label onto the agent", async () => {
  const store = new AgentStore("dev-box");
  const sup = new Supervisor({ client: fakeClient(), store, onDelta: () => {}, now: () => NOW });
  await sup.reconcile();
  expect(store.snapshot()[0]!.workspaceLabel).toBe("api work");
});

test("a status event for a known agent updates it without a reconcile", async () => {
  const store = new AgentStore("dev-box");
  const client = fakeClient();
  const deltas: Delta[] = [];
  const sup = new Supervisor({ client, store, onDelta: (d) => deltas.push(d), now: () => NOW });
  await sup.reconcile();
  const before = client.calls.length;

  sup.handleEvent({
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "blocked" },
  });

  expect(store.snapshot()[0]!.state).toBe("blocked");
  expect(client.calls).toHaveLength(before); // no extra round trip
  expect(deltas.at(-1)!.upserted[0]!.name).toBe("api-refactor"); // name preserved
});

test("a status event for an UNKNOWN agent triggers a reconcile to learn its name", async () => {
  const store = new AgentStore("dev-box");
  const client = fakeClient();
  const sup = new Supervisor({ client, store, onDelta: () => {}, now: () => NOW });
  await sup.reconcile();
  const before = client.calls.filter((c) => c === "agent.list").length;

  sup.handleEvent({
    event: "pane.agent_status_changed",
    data: { pane_id: "w9:p1", workspace_id: "w9", agent_status: "working" },
  });
  await Bun.sleep(20);

  expect(client.calls.filter((c) => c === "agent.list").length).toBe(before + 1);
});

test("lastEventAt is null before any event and set after one", async () => {
  const sup = new Supervisor({
    client: fakeClient(), store: new AgentStore("dev-box"), onDelta: () => {}, now: () => NOW,
  });
  expect(sup.lastEventAt).toBeNull();
  await sup.reconcile();
  sup.handleEvent({
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle" },
  });
  expect(sup.lastEventAt).toBe(NOW);
});

test("an unrelated event kind is ignored", async () => {
  const store = new AgentStore("dev-box");
  const sup = new Supervisor({ client: fakeClient(), store, onDelta: () => {}, now: () => NOW });
  await sup.reconcile();
  sup.handleEvent({ event: "pane.scroll_changed", data: { pane_id: "w1:p1" } });
  expect(store.snapshot()[0]!.state).toBe("working");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/supervisor.test.ts`
Expected: FAIL — cannot resolve `@server/supervisor`.

- [ ] **Step 3: Implement the supervisor**

Create `src/server/supervisor.ts`:

```ts
import { applyStatusEvent, toAgent, workspaceLabels } from "@server/herdr/adapter";
import {
  EVENT_AGENT_DETECTED,
  EVENT_PANE_CLOSED,
  EVENT_PANE_EXITED,
  EVENT_STATUS_CHANGED,
  GLOBAL_SUBSCRIPTIONS,
  statusSubscriptions,
  type Subscription,
} from "@server/herdr/socket";
import type { AgentStore, Delta } from "@server/state/store";
import type {
  HerdrAgentRaw,
  HerdrEvent,
  HerdrStatusChanged,
  HerdrWorkspaceRaw,
} from "@shared/herdr-api";

export interface HerdrClientLike {
  request<T>(method: string, params?: object): Promise<T>;
  openStream(subs: Subscription[]): Promise<void>;
}

export interface SupervisorOptions {
  client: HerdrClientLike;
  store: AgentStore;
  onDelta: (d: Delta) => void;
  /** Healing reconcile interval. Push is the primary mechanism. */
  reconcileMs?: number;
  now?: () => number;
}

// Delivered names, not subscribe names — see src/server/herdr/socket.ts.
// EVENT_STATUS_CHANGED is dotted; the lifecycle ones are underscored.
const LIFECYCLE_GONE: string[] = [EVENT_PANE_CLOSED, EVENT_PANE_EXITED];

export class Supervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private labels = new Map<string, string>();
  private eventAt: number | null = null;
  private readonly now: () => number;
  private readonly reconcileMs: number;

  constructor(private readonly opts: SupervisorOptions) {
    this.now = opts.now ?? Date.now;
    this.reconcileMs = opts.reconcileMs ?? 30_000;
  }

  get lastEventAt(): number | null {
    return this.eventAt;
  }

  /**
   * Reconcile BEFORE subscribing. Status events are per-pane, so the pane set
   * has to be known to name it. Subscribing first would name no panes and
   * silently deliver nothing.
   */
  async start(): Promise<void> {
    await this.reconcile();
    await this.resubscribe();
    this.timer = setInterval(() => {
      this.reconcile().catch((err) => console.error("reconcile failed", err));
    }, this.reconcileMs);
  }

  /**
   * Re-open the event stream naming every currently known agent pane, plus the
   * globals. A subscription set cannot be extended in place, so any change to
   * the pane set means replacing the stream.
   */
  private async resubscribe(): Promise<void> {
    const paneIds = this.opts.store.snapshot().map((a) => a.agentId);
    await this.opts.client.openStream([
      ...statusSubscriptions(paneIds),
      ...GLOBAL_SUBSCRIPTIONS,
    ]);
    console.info("herdr: subscribed", { panes: paneIds.length });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile(): Promise<Delta> {
    const now = this.now();

    const ws = await this.opts.client.request<{ workspaces: HerdrWorkspaceRaw[] }>(
      "workspace.list",
      {},
    );
    this.labels = workspaceLabels(ws.workspaces ?? []);

    const list = await this.opts.client.request<{ agents: HerdrAgentRaw[] }>("agent.list", {});
    const agents = (list.agents ?? [])
      .map((raw) => toAgent(raw, { hostId: this.opts.store.hostId, labels: this.labels, now }))
      .filter((a): a is NonNullable<typeof a> => a !== null);

    const delta = this.opts.store.replaceAll(agents, now);
    if (delta.upserted.length || delta.removedIds.length) this.opts.onDelta(delta);
    return delta;
  }

  /**
   * Re-learn the pane set and re-point the stream at it. Used whenever the set
   * changed: a new agent, a closed pane, or a status event for a pane we do not
   * know. Reconcile first — resubscribe() reads the pane set from the store.
   *
   * Public because Task 16 also calls it to recover after the stream drops.
   */
  async refresh(): Promise<void> {
    await this.reconcile();
    await this.resubscribe();
  }

  /**
   * Three kinds matter, and they do not share a naming convention:
   *
   *   pane.agent_status_changed  (dotted)      a known agent changed state
   *   pane_agent_detected        (underscored) a new agent appeared
   *   pane_closed / pane_exited  (underscored) an agent went away
   *
   * The status event carries no `name`, so it merges into a known agent. The
   * two lifecycle kinds change the pane set, which means the subscription set
   * is now stale and the stream must be re-opened.
   */
  handleEvent(e: HerdrEvent): void {
    if (e.event === EVENT_AGENT_DETECTED) {
      this.eventAt = this.now();
      console.info("herdr: new agent detected, resubscribing", (e.data as any).pane_id);
      this.refresh().catch((err) => console.error("refresh failed", err));
      return;
    }

    if (LIFECYCLE_GONE.includes(e.event)) {
      this.eventAt = this.now();
      const paneId = (e.data as any).pane_id as string;
      const delta = this.opts.store.remove(paneId);
      if (delta) {
        console.info("herdr: agent gone", paneId);
        this.opts.onDelta(delta);
      }
      // The closed pane is still named in the live subscription set.
      this.refresh().catch((err) => console.error("refresh failed", err));
      return;
    }

    if (e.event !== EVENT_STATUS_CHANGED) return;
    this.eventAt = this.now();
    const data = e.data as unknown as HerdrStatusChanged;

    if (!this.opts.store.has(data.pane_id)) {
      console.info("herdr: event for unknown agent, reconciling", data.pane_id);
      this.refresh().catch((err) => console.error("refresh failed", err));
      return;
    }

    const now = this.now();
    const next = this.opts.store.applyEvent(data.pane_id, (prev) =>
      applyStatusEvent(prev, data, now),
    );
    if (next) this.opts.onDelta({ upserted: [next], removedIds: [] });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/supervisor.test.ts`
Expected: 9 PASS.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/supervisor.ts tests/supervisor.test.ts
git commit -m "feat: supervisor wiring socket subscription, reconcile and store"
```

---

## Task 10: Hono server, routes and health

**Files:**
- Create: `src/server/routes.ts`, `src/server/index.ts`
- Test: `tests/routes.test.ts`

**Interfaces:**
- Consumes: `Hub`, `AgentStore`, `Supervisor`, `DemoSource`
- Produces:
  - `createApp(deps: AppDeps)` returning a Hono app
  - `interface AppDeps { store: AgentStore; hub: Hub; health: () => HealthBody }`
  - `interface HealthBody { ok: boolean; hostId: string; agents: number; clients: number; herdrConnected: boolean; lastEventAt: number | null }`

- [ ] **Step 1: Write the failing test**

Create `tests/routes.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

function app(over: Partial<{ lastEventAt: number | null; herdrConnected: boolean }> = {}) {
  const store = new AgentStore("dev-box");
  const hub = new Hub();
  return createApp({
    store,
    hub,
    health: () => ({
      ok: true, hostId: "dev-box", agents: store.snapshot().length,
      clients: hub.clientCount, herdrConnected: over.herdrConnected ?? true,
      lastEventAt: over.lastEventAt ?? null,
    }),
  });
}

test("GET /api/health returns ok and exposes lastEventAt", async () => {
  const res = await app({ lastEventAt: 1_700_000_000_000 }).request("/api/health");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.lastEventAt).toBe(1_700_000_000_000);
  expect(body).toHaveProperty("herdrConnected");
});

test("GET /api/agents returns the snapshot", async () => {
  const res = await app().request("/api/agents");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ hostId: "dev-box", agents: [] });
});

test("an unknown API path 404s rather than falling through", async () => {
  expect((await app().request("/api/nope")).status).toBe(404);
});

test("no route requires an auth token", async () => {
  // Access is the only gate; a token would 401 /sw.js and break the service worker.
  expect((await app().request("/api/health")).status).toBe(200);
  expect((await app().request("/api/agents")).status).toBe(200);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/routes.test.ts`
Expected: FAIL — cannot resolve `@server/routes`.

- [ ] **Step 3: Implement the routes**

Create `src/server/routes.ts`:

```ts
import { Hono } from "hono";
import type { AgentStore } from "@server/state/store";
import type { Hub } from "@server/ws/hub";

export interface HealthBody {
  ok: boolean;
  hostId: string;
  agents: number;
  clients: number;
  herdrConnected: boolean;
  /**
   * Epoch ms of the last herdr event. Exposed deliberately: a stuck event stream
   * is otherwise invisible, which is how a comparable system dropped every
   * event while reporting success.
   */
  lastEventAt: number | null;
}

export interface AppDeps {
  store: AgentStore;
  hub: Hub;
  health: () => HealthBody;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  // No authentication middleware. Cloudflare Access is the only gate — see
  // docs/decisions.md before adding one.
  app.get("/api/health", (c) => c.json(deps.health()));

  app.get("/api/agents", (c) =>
    c.json({ hostId: deps.store.hostId, agents: deps.store.snapshot() }),
  );

  return app;
}
```

- [ ] **Step 4: Implement the entry point**

Create `src/server/index.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/routes";
import { DemoSource, DEMO_HOST_ID } from "@server/demo";
import {
  HerdrStream,
  ProtocolMismatchError,
  checkProtocol,
  request,
  type Subscription,
} from "@server/herdr/socket";
import { AgentStore } from "@server/state/store";
import { Supervisor } from "@server/supervisor";
import { Hub, type HubClient } from "@server/ws/hub";

const args = new Set(Bun.argv.slice(2));
const DEMO = args.has("--demo");
const PORT = Number(process.env.PADDOCK_PORT ?? 8787);
const HOSTNAME = "127.0.0.1"; // loopback only; exposure is the tunnel's job

for (const unimplemented of ["agent", "hub"]) {
  if (args.has(unimplemented)) {
    console.error(`paddock ${unimplemented}: not implemented — see docs/roadmap.md`);
    process.exit(2);
  }
}

const socketPath =
  process.env.PADDOCK_HERDR_SOCKET ?? join(homedir(), ".config", "herdr", "herdr.sock");

const hostId = DEMO ? DEMO_HOST_ID : (process.env.PADDOCK_HOST_ID ?? "local");
const store = new AgentStore(hostId);
const hub = new Hub();

let herdrConnected = false;
let supervisor: Supervisor | null = null;
let demo: DemoSource | null = null;

if (DEMO) {
  demo = new DemoSource({ onDelta: (d) => hub.queue(d) });
  store.replaceAll(demo.snapshot(), Date.now());
  demo.start();
  herdrConnected = true;
  console.info("paddock: demo mode — synthetic agents, no herdr connection");
} else {
  // The stream is the only long-lived connection. Requests each open their own.
  const stream = new HerdrStream({
    path: socketPath,
    onEvent: (e) => supervisor?.handleEvent(e),
    onStateChange: (up) => {
      herdrConnected = up;
      console.info(`herdr event stream ${up ? "connected" : "disconnected"}`);
    },
  });
  const client = {
    request: <T,>(method: string, params?: object) => request<T>(socketPath, method, params),
    openStream: (subs: Subscription[]) => stream.open(subs),
  };
  supervisor = new Supervisor({ client, store, onDelta: (d) => hub.queue(d) });
  try {
    await checkProtocol(socketPath);
    await supervisor.start();
  } catch (err) {
    if (err instanceof ProtocolMismatchError) console.error(err.message);
    else console.error("failed to start against herdr:", err);
    process.exit(1);
  }
}

const app = createApp({
  store,
  hub,
  health: () => ({
    ok: true,
    hostId,
    agents: store.snapshot().length,
    clients: hub.clientCount,
    herdrConnected,
    lastEventAt: supervisor?.lastEventAt ?? (demo ? Date.now() : null),
  }),
});

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws") {
      return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      const client: HubClient = { send: (d) => ws.send(d) };
      (ws.data as { client?: HubClient }) = { client };
      hub.add(client);
      hub.sendSnapshot(client, hostId, store.snapshot());
    },
    close(ws) {
      const held = (ws.data as { client?: HubClient })?.client;
      if (held) hub.remove(held);
    },
    message() {
      // Read-only in v1: the browser sends nothing.
    },
  },
});

console.info(`paddock listening on http://${HOSTNAME}:${PORT}`);
```

- [ ] **Step 5: Run the tests and start it in demo mode**

```bash
bun test tests/routes.test.ts
bun src/server/index.ts --demo &
sleep 1
curl -s http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8787/api/agents | head -c 200
kill %1
```

Expected: 4 tests PASS; health returns `"ok":true`; agents returns six demo agents.

- [ ] **Step 6: Verify the loopback bind**

```bash
bun src/server/index.ts --demo &
sleep 1
ss -tlnp | grep 8787
kill %1
```

Expected: `127.0.0.1:8787` only. **Never `0.0.0.0:8787`.**

- [ ] **Step 7: Commit**

```bash
make check && make check-clean
git add src/server/routes.ts src/server/index.ts tests/routes.test.ts
git commit -m "feat: hono routes, websocket serving and loopback-only bind"
```

---

## Task 11: UI shell and design tokens

**Files:**
- Create: `index.html`, `vite.config.ts`, `src/web/styles.css`, `src/web/main.tsx`, `src/web/components/App.tsx`
- Test: `tests/tokens.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a Vite build serving `App`, and CSS custom properties `--bg --surface --border --fg --fg-dim --accent --warn --ok`

- [ ] **Step 1: Write the failing test**

Create `tests/tokens.test.ts`. This guards the spec rule that no colour may be defined only inside a media query.

```ts
import { expect, test } from "bun:test";

const TOKENS = ["--bg", "--surface", "--border", "--fg", "--fg-dim", "--accent", "--warn", "--ok"];

async function css(): Promise<string> {
  return await Bun.file("src/web/styles.css").text();
}

test("every token is defined on bare :root", async () => {
  const text = await css();
  const root = text.slice(text.indexOf(":root {"), text.indexOf("}", text.indexOf(":root {")));
  for (const t of TOKENS) expect(root).toContain(t);
});

test("dark overrides are guarded so a manual light toggle wins", async () => {
  expect(await css()).toContain(':root:not([data-theme="light"])');
});

test("an explicit dark toggle is honoured", async () => {
  expect(await css()).toContain(':root[data-theme="dark"]');
});

test("body has an explicit background token", async () => {
  expect(await css()).toMatch(/body\s*\{[^}]*background:\s*var\(--bg\)/);
});

test("no webfont is loaded", async () => {
  const text = await css();
  expect(text).not.toContain("@font-face");
  expect(text).not.toContain("fonts.googleapis");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/tokens.test.ts`
Expected: FAIL — `src/web/styles.css` does not exist.

- [ ] **Step 3: Write `src/web/styles.css`**

```css
@import "tailwindcss";

/* Light is the base palette. Every token is defined here — never only inside a
   media query, or the manual toggle has nothing to fall back to. */
:root {
  --bg: #ffffff;
  --surface: #f6f7f9;
  --border: #e3e5e9;
  --fg: #14161a;
  --fg-dim: #5f6672;
  --accent: #4a55c7;
  --warn: #9a6600;
  --ok: #1a7f37;
}

/* System dark, unless the user explicitly chose light. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #08090a;
    --surface: #12141a;
    --border: #1f2126;
    --fg: #f7f8f8;
    --fg-dim: #8a8f98;
    --accent: #5e6ad2;
    --warn: #e0a838;
    --ok: #3fb950;
  }
}

/* Explicit dark toggle wins regardless of system preference. */
:root[data-theme="dark"] {
  --bg: #08090a;
  --surface: #12141a;
  --border: #1f2126;
  --fg: #f7f8f8;
  --fg-dim: #8a8f98;
  --accent: #5e6ad2;
  --warn: #e0a838;
  --ok: #3fb950;
}

/* System fonts only. A webfont would be the single largest payload on a slow
   link, and SF/Segoe/Roboto read better at 12px than most alternatives. */
html {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-text-size-adjust: 100%;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  letter-spacing: -0.01em;
}

/* Touch devices get larger targets; hover affordances are additive only, never
   the sole route to an action. */
@media (pointer: coarse) {
  .tap {
    min-height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

.safe-bottom {
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
```

- [ ] **Step 4: Write `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>paddock</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Write `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    // One chunk on purpose: at high RTT an extra round trip costs more than the
    // bytes code-splitting would save, and this is a single screen.
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
```

- [ ] **Step 6: Write `src/web/main.tsx` and a placeholder `App`**

`src/web/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { App } from "@web/components/App";
import "@web/styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing from index.html");
createRoot(el).render(<App />);
```

`src/web/components/App.tsx`:

```tsx
export function App() {
  return (
    <main className="mx-auto max-w-2xl px-3 py-4">
      <h1 className="text-sm font-semibold">paddock</h1>
    </main>
  );
}
```

- [ ] **Step 7: Run the tests and build**

```bash
bun test tests/tokens.test.ts
bun run build:web
```

Expected: 5 tests PASS; the build writes `dist/`.

- [ ] **Step 8: Commit**

```bash
make check && make check-clean
git add index.html vite.config.ts src/web tests/tokens.test.ts
git commit -m "feat: UI shell with theme-aware tokens and no webfont"
```

---

## Task 12: Client store and connection lifecycle

**Files:**
- Create: `src/web/store.ts`
- Test: `tests/web-store.test.ts`

**Interfaces:**
- Consumes: `Agent`, `ServerMessage` from `@shared/types`
- Produces:
  - `wsUrlFrom(loc: { protocol: string; host: string }): string`
  - `backoffMs(attempt: number, rand?: () => number): number`
  - `interface ClientState { agents: Agent[]; hostId: string | null; connected: boolean; lastMessageAt: number | null }`
  - `applyMessage(state: ClientState, msg: ServerMessage): ClientState`
  - `isStale(state: ClientState, now: number, thresholdMs?: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/web-store.test.ts`:

```ts
import { expect, test } from "bun:test";
import { applyMessage, backoffMs, isStale, type ClientState } from "@web/store";
import type { Agent } from "@shared/types";
import { wsUrlFrom } from "@web/store";

const NOW = 1_700_000_000_000;
const EMPTY: ClientState = { agents: [], hostId: null, connected: false, lastMessageAt: null };

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "working", workspaceId: "w1",
    workspaceLabel: null, cwd: "/srv/project", stateSince: NOW, updatedAt: NOW, ...over,
  };
}

test("wsUrlFrom uses wss on https", () => {
  expect(wsUrlFrom({ protocol: "https:", host: "paddock.example.com" }))
    .toBe("wss://paddock.example.com/ws");
});

test("wsUrlFrom uses ws on http", () => {
  expect(wsUrlFrom({ protocol: "http:", host: "127.0.0.1:8787" }))
    .toBe("ws://127.0.0.1:8787/ws");
});

test("wsUrlFrom does NOT special-case localhost", () => {
  // A hostname allowlist is how a working dashboard silently becomes a demo screen.
  expect(wsUrlFrom({ protocol: "http:", host: "localhost:8787" }))
    .toBe("ws://localhost:8787/ws");
});

test("a snapshot replaces all state", () => {
  const next = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW,
  });
  expect(next.agents).toHaveLength(1);
  expect(next.hostId).toBe("dev-box");
  expect(next.lastMessageAt).toBe(NOW);
});

test("a snapshot is idempotent", () => {
  const msg = { type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW } as const;
  expect(applyMessage(applyMessage(EMPTY, msg), msg).agents).toHaveLength(1);
});

test("a delta upserts by agentId", () => {
  const base = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW,
  });
  const next = applyMessage(base, {
    type: "delta", upserted: [agent({ state: "blocked" })], removedIds: [], serverTime: NOW + 1,
  });
  expect(next.agents).toHaveLength(1);
  expect(next.agents[0]!.state).toBe("blocked");
});

test("a delta removes by id", () => {
  const base = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box",
    agents: [agent(), agent({ agentId: "w2:p1", name: "docs-cleanup" })], serverTime: NOW,
  });
  const next = applyMessage(base, {
    type: "delta", upserted: [], removedIds: ["w2:p1"], serverTime: NOW + 1,
  });
  expect(next.agents.map((a) => a.agentId)).toEqual(["w1:p1"]);
});

test("backoff grows and stays within the cap", () => {
  const fixed = () => 0.5;
  expect(backoffMs(0, fixed)).toBeLessThan(backoffMs(3, fixed));
  for (let i = 0; i < 20; i++) expect(backoffMs(i, fixed)).toBeLessThanOrEqual(15_000);
});

test("backoff includes jitter so clients do not retry in lockstep", () => {
  expect(backoffMs(5, () => 0)).not.toBe(backoffMs(5, () => 0.99));
});

test("state is stale when disconnected", () => {
  expect(isStale({ ...EMPTY, connected: false, lastMessageAt: NOW }, NOW + 1)).toBe(true);
});

test("state is stale when no message has arrived within the threshold", () => {
  const s = { ...EMPTY, connected: true, lastMessageAt: NOW };
  expect(isStale(s, NOW + 61_000)).toBe(true);
  expect(isStale(s, NOW + 10_000)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/web-store.test.ts`
Expected: FAIL — cannot resolve `@web/store`.

- [ ] **Step 3: Add the `@web` path to `tsconfig.json`**

Confirm `paths` already contains `"@web/*": ["./src/web/*"]` from Task 1. It does — no change needed.

- [ ] **Step 4: Implement `src/web/store.ts`**

```ts
import { create } from "zustand";
import type { Agent, ServerMessage } from "@shared/types";

export interface ClientState {
  agents: Agent[];
  hostId: string | null;
  connected: boolean;
  lastMessageAt: number | null;
}

const STALE_AFTER_MS = 60_000;

/**
 * Derive the socket URL from the page's own origin, unconditionally.
 * No hostname allowlist — special-casing one host is how a working dashboard
 * silently falls back to a demo screen.
 */
export function wsUrlFrom(loc: { protocol: string; host: string }): string {
  const scheme = loc.protocol === "https:" ? "wss://" : "ws://";
  return `${scheme}${loc.host}/ws`;
}

/** Exponential backoff with jitter, capped, so retries never synchronise. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(15_000, 500 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.5 + rand() * 0.5));
}

export function applyMessage(state: ClientState, msg: ServerMessage): ClientState {
  if (msg.type === "snapshot") {
    return {
      ...state,
      hostId: msg.hostId,
      agents: msg.agents,
      lastMessageAt: msg.serverTime,
    };
  }
  const byId = new Map(state.agents.map((a) => [a.agentId, a]));
  for (const a of msg.upserted) byId.set(a.agentId, a);
  for (const id of msg.removedIds) byId.delete(id);
  return { ...state, agents: [...byId.values()], lastMessageAt: msg.serverTime };
}

export function isStale(state: ClientState, now: number, thresholdMs = STALE_AFTER_MS): boolean {
  if (!state.connected) return true;
  if (state.lastMessageAt === null) return true;
  return now - state.lastMessageAt > thresholdMs;
}

interface Store extends ClientState {
  connect: () => void;
}

export const useStore = create<Store>((set, get) => {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (document.visibilityState === "hidden") return;
    ws = new WebSocket(wsUrlFrom(window.location));

    ws.onopen = () => {
      attempt = 0;
      set({ connected: true });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch (err) {
        console.error("paddock: unparseable server message", err);
        return;
      }
      set(applyMessage(get(), msg));
    };
    ws.onclose = () => {
      set({ connected: false });
      ws = null;
      // A fresh snapshot arrives on reconnect; deltas are never assumed to resume.
      retry = setTimeout(open, backoffMs(attempt++));
    };
    ws.onerror = (err) => console.error("paddock: websocket error", err);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ws === null) {
      if (retry) clearTimeout(retry);
      attempt = 0;
      open();
    }
  });

  return {
    agents: [],
    hostId: null,
    connected: false,
    lastMessageAt: null,
    connect: open,
  };
});
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/web-store.test.ts`
Expected: 11 PASS.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean
git add src/web/store.ts tests/web-store.test.ts
git commit -m "feat: client store with jittered backoff and staleness detection"
```

---

## Task 13: Triage sections and agent rows

> ⚠️ **Read spec §14 question 4 before building "Needs you".** herdr derives
> `done` from idle-plus-*unseen*, where seen means the tab was focused in the
> herdr desktop UI — and reading over the socket does not clear it. So a `done`
> agent answered from the phone stays `done`, and this section keeps showing it
> until the operator returns to the desk. v1 ships the section as specified; the
> question is flagged so it is a known limitation rather than a surprise bug
> report.

**Files:**
- Create: `src/web/components/ConnectionBanner.tsx`, `HostHeader.tsx`, `AgentRow.tsx`, `AgentCard.tsx`, `Section.tsx`, `elapsed.ts`
- Modify: `src/web/components/App.tsx`
- Test: `tests/elapsed.test.ts`, `tests/grouping.test.ts`

**Interfaces:**
- Consumes: `Agent`, `sectionFor`, `SECTION_ORDER`, `useStore`, `isStale`
- Produces:
  - `formatElapsed(ms: number): string`
  - `groupAgents(agents: Agent[]): Record<Section, Agent[]>`

- [ ] **Step 1: Write the failing tests**

Create `tests/elapsed.test.ts`:

```ts
import { expect, test } from "bun:test";
import { formatElapsed } from "@web/components/elapsed";

test("under a minute reads as now", () => {
  expect(formatElapsed(0)).toBe("now");
  expect(formatElapsed(59_000)).toBe("now");
});

test("minutes", () => {
  expect(formatElapsed(60_000)).toBe("1m");
  expect(formatElapsed(14 * 60_000)).toBe("14m");
});

test("hours", () => {
  expect(formatElapsed(60 * 60_000)).toBe("1h");
  expect(formatElapsed(150 * 60_000)).toBe("2h");
});

test("days", () => {
  expect(formatElapsed(26 * 60 * 60_000)).toBe("1d");
});

test("negative clock skew does not produce a negative label", () => {
  expect(formatElapsed(-5000)).toBe("now");
});
```

Create `tests/grouping.test.ts`:

```ts
import { expect, test } from "bun:test";
import { groupAgents } from "@web/components/Section";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(name: string, state: Agent["state"]): Agent {
  return {
    hostId: "dev-box", agentId: name, name, task: `task for ${name}`, state,
    workspaceId: "w1", workspaceLabel: null, cwd: "/srv/project",
    stateSince: NOW, updatedAt: NOW,
  };
}

test("blocked and done both land in needs-you", () => {
  const g = groupAgents([agent("a", "blocked"), agent("b", "done")]);
  expect(g["needs-you"].map((x) => x.name)).toEqual(["a", "b"]);
});

test("working and idle are separated", () => {
  const g = groupAgents([agent("c", "working"), agent("d", "idle")]);
  expect(g.working.map((x) => x.name)).toEqual(["c"]);
  expect(g.idle.map((x) => x.name)).toEqual(["d"]);
});

test("every section key exists even when empty", () => {
  const g = groupAgents([]);
  expect(Object.keys(g).sort()).toEqual(["idle", "needs-you", "working"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/elapsed.test.ts tests/grouping.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `src/web/components/elapsed.ts`**

```ts
/** Compact elapsed label. Answers "is this stuck?" better than a timestamp. */
export function formatElapsed(ms: number): string {
  if (ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
```

- [ ] **Step 4: Implement `src/web/components/Section.tsx`**

```tsx
import { SECTION_ORDER, sectionFor, type Agent, type Section as SectionKey } from "@shared/types";

export function groupAgents(agents: Agent[]): Record<SectionKey, Agent[]> {
  const out = { "needs-you": [], working: [], idle: [] } as Record<SectionKey, Agent[]>;
  for (const a of agents) out[sectionFor(a.state)].push(a);
  return out;
}

export const SECTION_TITLES: Record<SectionKey, string> = {
  "needs-you": "Needs you",
  working: "Working",
  idle: "Idle",
};

export { SECTION_ORDER };

export function SectionHeader({
  title, count, expandable, expanded, onToggle,
}: {
  title: string;
  count: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const label = (
    <>
      <span className="text-[9.5px] font-bold uppercase tracking-[0.09em]">{title}</span>
      <span className="text-[9.5px]"> · {count}</span>
    </>
  );
  if (!expandable) {
    return (
      <div className="px-3 pt-3 pb-1.5" style={{ color: "var(--fg-dim)" }}>
        {label}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="tap w-full px-3 pt-3 pb-1.5 text-left"
      style={{ color: "var(--fg-dim)" }}
    >
      {label} <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
    </button>
  );
}
```

- [ ] **Step 5: Implement `src/web/components/AgentRow.tsx`**

```tsx
import type { Agent } from "@shared/types";
import { formatElapsed } from "@web/components/elapsed";

const DOT: Record<Agent["state"], string> = {
  blocked: "var(--warn)",
  done: "var(--ok)",
  working: "var(--accent)",
  idle: "var(--fg-dim)",
};

export function StateDot({ state }: { state: Agent["state"] }) {
  return (
    <span
      aria-hidden="true"
      className="h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ background: DOT[state] }}
    />
  );
}

/** Dense row. Task text truncates to keep the list scannable. */
export function AgentRow({ agent, now }: { agent: Agent; now: number }) {
  return (
    <div
      className="tap flex items-center gap-2.5 px-3 py-2.5"
      style={{ borderTop: "1px solid var(--border)" }}
    >
      <StateDot state={agent.state} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold">{agent.name}</div>
        <div className="truncate text-[11px]" style={{ color: "var(--fg-dim)" }}>
          {agent.task}
        </div>
      </div>
      <span className="shrink-0 text-[10px]" style={{ color: "var(--fg-dim)" }}>
        {formatElapsed(now - agent.stateSince)}
      </span>
    </div>
  );
}

export function AgentChip({ agent }: { agent: Agent }) {
  return (
    <span
      className="rounded-full px-2.5 py-1 text-[10px]"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--fg-dim)" }}
    >
      {agent.name}
    </span>
  );
}
```

- [ ] **Step 6: Implement `src/web/components/AgentCard.tsx`**

```tsx
import type { Agent } from "@shared/types";
import { formatElapsed } from "@web/components/elapsed";
import { StateDot } from "@web/components/AgentRow";

/** Full card for anything in Needs you. Task text wraps — it must be readable. */
export function AgentCard({ agent, now }: { agent: Agent; now: number }) {
  const accent = agent.state === "blocked" ? "var(--warn)" : "var(--ok)";
  return (
    <article
      className="mx-2 mb-1.5 rounded-lg p-3"
      style={{ background: "var(--surface)", border: `1px solid ${accent}` }}
    >
      <header className="flex items-center gap-2">
        <StateDot state={agent.state} />
        <h3 className="text-[12.5px] font-semibold">{agent.name}</h3>
        <span className="ml-auto text-[10px]" style={{ color: "var(--fg-dim)" }}>
          {formatElapsed(now - agent.stateSince)}
        </span>
      </header>
      <p className="mt-1.5 text-[11px] leading-snug" style={{ color: "var(--fg-dim)" }}>
        {agent.task}
      </p>
      <p className="mt-2 text-[10px]" style={{ color: "var(--fg-dim)" }}>
        {agent.state === "blocked" ? "Waiting for input" : "Finished"}
      </p>
    </article>
  );
}
```

- [ ] **Step 7: Implement `ConnectionBanner.tsx` and `HostHeader.tsx`**

`src/web/components/ConnectionBanner.tsx`:

```tsx
import { formatElapsed } from "@web/components/elapsed";

/** Staleness is shown, never hidden. Old data presented confidently is worse. */
export function ConnectionBanner({
  connected, lastMessageAt, now,
}: {
  connected: boolean;
  lastMessageAt: number | null;
  now: number;
}) {
  const age = lastMessageAt === null ? null : formatElapsed(now - lastMessageAt);
  return (
    <div
      role="status"
      className="px-3 py-2 text-[11px]"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--warn)", color: "var(--warn)" }}
    >
      {connected ? "Waiting for updates" : "Reconnecting"}
      {age === null ? " · no data yet" : ` · last updated ${age} ago`}
    </div>
  );
}
```

`src/web/components/HostHeader.tsx`:

```tsx
import type { Agent } from "@shared/types";

export function HostHeader({ hostId, agents }: { hostId: string | null; agents: Agent[] }) {
  const n = (s: Agent["state"]) => agents.filter((a) => a.state === s).length;
  const parts = [
    n("blocked") + n("done") > 0 ? `${n("blocked") + n("done")} needs you` : null,
    n("working") > 0 ? `${n("working")} working` : null,
    n("idle") > 0 ? `${n("idle")} idle` : null,
  ].filter(Boolean);
  return (
    <header
      className="flex items-center justify-between px-3 py-3"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <h1 className="text-[13px] font-semibold">{hostId ?? "connecting…"}</h1>
      <span className="text-[10px]" style={{ color: "var(--fg-dim)" }}>
        {parts.length ? parts.join(" · ") : "no agents"}
      </span>
    </header>
  );
}
```

- [ ] **Step 8: Rewrite `src/web/components/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { isStale, useStore } from "@web/store";
import { AgentCard } from "@web/components/AgentCard";
import { AgentChip, AgentRow } from "@web/components/AgentRow";
import { ConnectionBanner } from "@web/components/ConnectionBanner";
import { HostHeader } from "@web/components/HostHeader";
import { groupAgents, SECTION_ORDER, SECTION_TITLES, SectionHeader } from "@web/components/Section";

export function App() {
  const { agents, hostId, connected, lastMessageAt, connect } = useStore();
  const [now, setNow] = useState(() => Date.now());
  const [idleOpen, setIdleOpen] = useState(false);

  useEffect(() => {
    connect();
  }, [connect]);

  // Elapsed labels tick locally; the server is not asked for time.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const groups = groupAgents(agents);
  const stale = isStale({ agents, hostId, connected, lastMessageAt }, now);

  return (
    <main className="mx-auto max-w-2xl safe-bottom">
      {stale && (
        <ConnectionBanner connected={connected} lastMessageAt={lastMessageAt} now={now} />
      )}
      <HostHeader hostId={hostId} agents={agents} />

      {SECTION_ORDER.map((key) => {
        const list = groups[key];
        if (list.length === 0) return null;
        const collapsible = key === "idle";
        const open = !collapsible || idleOpen;
        return (
          <section key={key}>
            <SectionHeader
              title={SECTION_TITLES[key]}
              count={list.length}
              expandable={collapsible}
              expanded={open}
              onToggle={() => setIdleOpen((v) => !v)}
            />
            {key === "needs-you"
              ? list.map((a) => <AgentCard key={a.agentId} agent={a} now={now} />)
              : open
                ? list.map((a) => <AgentRow key={a.agentId} agent={a} now={now} />)
                : (
                  <div className="flex flex-wrap gap-1.5 px-3 pb-3">
                    {list.map((a) => (
                      <AgentChip key={a.agentId} agent={a} />
                    ))}
                  </div>
                )}
          </section>
        );
      })}

      {agents.length === 0 && !stale && (
        <p className="px-3 py-6 text-[11px]" style={{ color: "var(--fg-dim)" }}>
          No agents detected.
        </p>
      )}
    </main>
  );
}
```

- [ ] **Step 9: Run the tests and view it**

```bash
bun test tests/elapsed.test.ts tests/grouping.test.ts
bun src/server/index.ts --demo &
bun run dev:web
```

Open the Vite URL. Expected: 8 tests PASS; the dashboard shows `schema-migration` blocked and `lint-config` done in Needs you, two working rows, and two idle chips, with a state rotating every 4s.

- [ ] **Step 10: Commit**

```bash
make check && make check-clean
git add src/web/components tests/elapsed.test.ts tests/grouping.test.ts
git commit -m "feat: triage sections, dense rows and staleness banner"
```

---

## Task 14: PWA manifest and capability-gated install prompt

**Files:**
- Create: `public/manifest.webmanifest`, `src/web/install.ts`, `src/web/components/InstallHint.tsx`
- Modify: `index.html`, `src/web/components/App.tsx`
- Test: `tests/install.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `shouldOfferInstall(env: InstallEnv): boolean`, `interface InstallEnv { standalone: boolean; installEventSeen: boolean; iosSafari: boolean; dismissed: boolean }`

- [ ] **Step 1: Write the failing test**

Create `tests/install.test.ts`. These tests encode the rule that the prompt is gated on capability, never on device class.

```ts
import { expect, test } from "bun:test";
import { shouldOfferInstall, type InstallEnv } from "@web/install";

const base: InstallEnv = {
  standalone: false, installEventSeen: false, iosSafari: false, dismissed: false,
};

test("offers when the browser fired the install event", () => {
  expect(shouldOfferInstall({ ...base, installEventSeen: true })).toBe(true);
});

test("offers on iOS Safari, which has no install event", () => {
  expect(shouldOfferInstall({ ...base, iosSafari: true })).toBe(true);
});

test("does NOT offer when already installed", () => {
  expect(shouldOfferInstall({ ...base, installEventSeen: true, standalone: true })).toBe(false);
});

test("does NOT offer once dismissed", () => {
  expect(shouldOfferInstall({ ...base, installEventSeen: true, dismissed: true })).toBe(false);
});

test("does NOT offer to a browser that cannot install", () => {
  // A desktop browser without install support must see nothing — the old bug was
  // showing a mobile-only button purely because of a device guess.
  expect(shouldOfferInstall(base)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/install.test.ts`
Expected: FAIL — cannot resolve `@web/install`.

- [ ] **Step 3: Implement `src/web/install.ts`**

```ts
export interface InstallEnv {
  /** Already running as an installed app. */
  standalone: boolean;
  /** The browser fired `beforeinstallprompt`. */
  installEventSeen: boolean;
  /** iOS Safari, detected by capability shape — it never fires the install event. */
  iosSafari: boolean;
  dismissed: boolean;
}

/**
 * Gate on capability and install state ONLY. There is no device check anywhere:
 * offering a mobile-shaped button because of a user-agent guess is the bug this
 * replaces.
 */
export function shouldOfferInstall(env: InstallEnv): boolean {
  if (env.standalone || env.dismissed) return false;
  return env.installEventSeen || env.iosSafari;
}

const DISMISS_KEY = "paddock.install.dismissed";

export function readInstallEnv(installEventSeen: boolean): InstallEnv {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS exposes this non-standard flag on navigator when installed.
    (navigator as unknown as { standalone?: boolean }).standalone === true;

  // Feature-shaped test: a touch-capable WebKit that supports share but not the
  // install event. No user-agent string is parsed.
  const iosSafari =
    "share" in navigator &&
    "ontouchend" in document &&
    !("onbeforeinstallprompt" in window);

  return {
    standalone,
    installEventSeen,
    iosSafari,
    dismissed: localStorage.getItem(DISMISS_KEY) === "1",
  };
}

export function dismissInstall(): void {
  localStorage.setItem(DISMISS_KEY, "1");
}
```

- [ ] **Step 4: Create `public/manifest.webmanifest`**

```json
{
  "name": "paddock",
  "short_name": "paddock",
  "description": "Watch and answer coding agents from anywhere.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#08090a",
  "theme_color": "#08090a",
  "icons": []
}
```

- [ ] **Step 5: Link the manifest from `index.html`**

Add inside `<head>`, after the `color-scheme` meta:

```html
    <link rel="manifest" href="/manifest.webmanifest" />
```

- [ ] **Step 6: Implement `src/web/components/InstallHint.tsx`**

```tsx
import { useEffect, useState } from "react";
import { dismissInstall, readInstallEnv, shouldOfferInstall } from "@web/install";

export function InstallHint() {
  const [eventSeen, setEventSeen] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEventSeen(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (hidden || !shouldOfferInstall(readInstallEnv(eventSeen))) return null;

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 text-[11px]"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
    >
      <span style={{ color: "var(--fg-dim)" }}>Add to your home screen for quicker access.</span>
      <button
        type="button"
        className="tap ml-auto rounded px-2 py-1"
        style={{ border: "1px solid var(--border)", color: "var(--fg)" }}
        onClick={() => {
          dismissInstall();
          setHidden(true);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
```

- [ ] **Step 7: Render it in `App.tsx`**

Add the import and place it directly above `<HostHeader …/>`:

```tsx
import { InstallHint } from "@web/components/InstallHint";
```

```tsx
      <InstallHint />
      <HostHeader hostId={hostId} agents={agents} />
```

- [ ] **Step 8: Run the tests and build**

```bash
bun test tests/install.test.ts
bun run build:web
grep -rIn "isMobile\|userAgent\|navigator.platform" src/ || echo "no device detection — correct"
```

Expected: 5 tests PASS; build succeeds; the grep prints the confirmation line.

- [ ] **Step 9: Commit**

```bash
make check && make check-clean
git add public/manifest.webmanifest src/web/install.ts src/web/components/InstallHint.tsx index.html src/web/components/App.tsx tests/install.test.ts
git commit -m "feat: PWA manifest and capability-gated install hint"
```

---

## Task 15: Serve the built UI, Docker, and docs

**Files:**
- Modify: `src/server/routes.ts`, `src/server/index.ts`
- Create: `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, `docs/architecture.md`, `docs/decisions.md`, `docs/gotchas.md`, `docs/roadmap.md`, `docs/deploy-cloudflare.md`
- Test: `tests/static.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: a running container serving the dashboard on `127.0.0.1:8787`

- [ ] **Step 1: Write the failing test**

Create `tests/static.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

function app() {
  const store = new AgentStore("dev-box");
  const hub = new Hub();
  return createApp({
    store, hub,
    health: () => ({
      ok: true, hostId: "dev-box", agents: 0, clients: 0,
      herdrConnected: true, lastEventAt: null,
    }),
    staticDir: "dist",
  });
}

test("an unknown non-API path falls back to index.html for the SPA", async () => {
  const res = await app().request("/some/deep/link");
  // 200 when dist/ has been built, 404 before that. Either proves it is not a
  // JSON 404 from the API router.
  expect([200, 404]).toContain(res.status);
  expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
});

test("API 404s stay JSON and never fall back to index.html", async () => {
  const res = await app().request("/api/nope");
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/static.test.ts`
Expected: FAIL — `createApp` does not accept `staticDir`.

- [ ] **Step 3: Add static serving to `src/server/routes.ts`**

Add `staticDir` to `AppDeps` and append the handlers **after** the API routes:

```ts
export interface AppDeps {
  store: AgentStore;
  hub: Hub;
  health: () => HealthBody;
  /** Built UI directory. Omit in tests that only exercise the API. */
  staticDir?: string;
}
```

Then, at the end of `createApp` before `return app`:

```ts
  // API 404s must stay JSON, so this guard comes before the SPA fallback.
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (deps.staticDir) {
    const dir = deps.staticDir;
    app.get("/*", async (c) => {
      const path = new URL(c.req.url).pathname;
      const candidate = Bun.file(`${dir}${path}`);
      if (path !== "/" && (await candidate.exists())) {
        // Content-hashed assets are safe to cache forever.
        const immutable = /\.[0-9a-f]{8,}\.(js|css|woff2|svg|png)$/.test(path);
        return new Response(candidate, {
          headers: immutable ? { "cache-control": "public, max-age=31536000, immutable" } : {},
        });
      }
      const index = Bun.file(`${dir}/index.html`);
      if (!(await index.exists())) return c.text("UI not built — run `make build`", 404);
      return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
    });
  }
```

- [ ] **Step 4: Pass `staticDir` from `src/server/index.ts`**

Change the `createApp({...})` call to include:

```ts
  staticDir: process.env.PADDOCK_STATIC_DIR ?? "dist",
```

- [ ] **Step 5: Run the tests**

```bash
bun run build:web
bun test
```

Expected: the whole suite passes.

- [ ] **Step 6: Create the `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./
EXPOSE 8787
CMD ["bun", "src/server/index.ts"]
```

- [ ] **Step 7: Create `docker-compose.yml`**

```yaml
services:
  paddock:
    build: .
    # Must match the host user: the herdr socket is guarded by filesystem
    # permissions, so root or a mismatched UID gets EACCES.
    user: "${UID}:${GID}"
    # 127.0.0.1 prefix is REQUIRED. The short form "8787:8787" publishes on every
    # interface and exposes the dashboard to the local network.
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - ${HOME}/.config/herdr/herdr.sock:/herdr.sock:rw
    environment:
      PADDOCK_HERDR_SOCKET: /herdr.sock
      PADDOCK_PORT: "8787"
      PADDOCK_HOST_ID: ${PADDOCK_HOST_ID:-local}
    restart: unless-stopped
```

- [ ] **Step 8: Create `.env.example`**

```bash
# Copy to .env. Never commit .env.
# Label for this machine, shown in the dashboard header.
PADDOCK_HOST_ID=local
# Override only if herdr's socket is not at $HOME/.config/herdr/herdr.sock
# PADDOCK_HERDR_SOCKET=/herdr.sock
PADDOCK_PORT=8787
```

- [ ] **Step 9: Write the docs**

Create each file with the content indicated. Keep them short and specific.

`README.md` — what paddock is; a `paddock serve --demo` quick start; a screenshot note stating images come from demo mode; and this attribution paragraph:

> The idea comes from [herdr-remote](https://github.com/dcolinmorgan/herdr-remote) by
> dcolinmorgan — pushing herdr agent status to a phone for monitoring and one-tap
> approval. paddock reuses that concept with a different transport, stack and UI.

`docs/architecture.md` — the module table and the one-way dependency rule from this plan's File Structure section.

`docs/decisions.md` — one entry per decision, each with the reason:
1. Unix socket over CLI/plugin — no per-event process spawn, action methods on one connection.
2. Generated types from `herdr api schema` — hand-transcribed contracts drift silently.
3. No application auth token — it would 401 `/sw.js` and disable the service worker; Access provides identity, policy and audit that a shared secret does not.
4. `agent.list` not `pane.list` — only `agent.list` returns `name`.
5. One JS chunk — at high RTT a round trip costs more than the bytes splitting saves.
6. No webfont — the single largest available payload saving.

`docs/gotchas.md` — the failure-mode table from spec §12.

`docs/roadmap.md` — spec §13 backlog, plus the outcome of Task 2 if it changed anything.

`docs/deploy-cloudflare.md` — add a tunnel public hostname of type **HTTP** pointing at `localhost:8787`; add an Access self-hosted application for that hostname; verify with a request that must return a redirect to the Access login rather than `200`. State plainly that a `200` means Access is not in front and paddock has no auth of its own.

- [ ] **Step 10: Build and run the container**

```bash
make up
sleep 5
curl -s http://127.0.0.1:8787/api/health
ss -tlnp | grep 8787
make logs | tail -20
```

Expected: health returns `"ok":true` and `"herdrConnected":true`; `ss` shows `127.0.0.1:8787` **only**; logs show the agent count.

- [ ] **Step 11: Verify against real agents**

Open `http://127.0.0.1:8787` in a browser. Expected: your real agents, each showing its **own** name and current task — not the same label repeated.

- [ ] **Step 12: Commit**

```bash
make check && make check-clean && make test
git add src/server/routes.ts src/server/index.ts tests/static.test.ts Dockerfile docker-compose.yml .env.example README.md docs/
git commit -m "feat: serve built UI, add Docker deployment and documentation"
```

---

## Task 16: herdr event stream auto-reconnect

Without this, a herdr restart leaves paddock permanently useless until the
container restarts. `restart: unless-stopped` does not help — the process stays
alive and simply reports nothing.

**Only the event stream needs reconnect logic.** Requests already open a fresh
connection each time, so a herdr restart makes the *next* request succeed on its
own; there is no stale request connection to repair. What breaks permanently is
the one long-lived stream, and recovering it means re-running
`Supervisor.refresh()` — reconcile to re-learn the pane set, then re-subscribe
naming those panes.

**Files:**
- Create: `src/server/herdr/keeper.ts`
- Modify: `src/server/index.ts` — drive the keeper from the stream's `onStateChange`
- Test: `tests/keeper.test.ts`

**Interfaces:**
- Consumes: `ProtocolMismatchError` (Task 4), `Supervisor.refresh()` (Task 9)
- Produces:
  - `class StreamKeeper`
  - `new StreamKeeper(opts: { refresh: () => Promise<void>; backoff?: (attempt: number) => number; sleep?: (ms: number) => Promise<void>; onFatal?: (err: Error) => void })`
  - `notifyClosed(): void` — idempotent; starts a retry loop if one is not running
  - `stop(): void`, `get reconnecting(): boolean`, `get attempts(): number`
  - `function backoffWithJitter(attempt: number, random?: () => number): number`

- [ ] **Step 1: Write the failing test**

Create `tests/keeper.test.ts`:

```ts
import { expect, test } from "bun:test";
import { StreamKeeper, backoffWithJitter } from "@server/herdr/keeper";
import { ProtocolMismatchError } from "@server/herdr/socket";

const noSleep = async () => {};

test("retries until refresh succeeds", async () => {
  let calls = 0;
  const keeper = new StreamKeeper({
    refresh: async () => {
      calls++;
      if (calls < 3) throw new Error("herdr is down");
    },
    sleep: noSleep,
  });

  keeper.notifyClosed();
  await keeper.settled();

  expect(calls).toBe(3);
  expect(keeper.reconnecting).toBe(false);
});

test("a second notifyClosed while retrying does not start a second loop", async () => {
  let calls = 0;
  const keeper = new StreamKeeper({
    refresh: async () => {
      calls++;
      if (calls < 2) throw new Error("still down");
    },
    sleep: noSleep,
  });

  keeper.notifyClosed();
  keeper.notifyClosed();
  keeper.notifyClosed();
  await keeper.settled();

  expect(calls).toBe(2); // not 6
});

test("stop() halts the retry loop", async () => {
  let calls = 0;
  const keeper = new StreamKeeper({
    refresh: async () => { calls++; throw new Error("down"); },
    sleep: async () => { keeper.stop(); },
  });

  keeper.notifyClosed();
  await keeper.settled();

  expect(calls).toBe(1);
  expect(keeper.reconnecting).toBe(false);
});

test("a protocol mismatch is fatal and is never retried", async () => {
  let calls = 0;
  let fatal: Error | null = null;
  const keeper = new StreamKeeper({
    refresh: async () => { calls++; throw new ProtocolMismatchError(19, 20); },
    sleep: noSleep,
    onFatal: (e) => { fatal = e; },
  });

  keeper.notifyClosed();
  await keeper.settled();

  expect(calls).toBe(1); // retrying a version mismatch can never succeed
  expect(fatal).toBeInstanceOf(ProtocolMismatchError);
});

test("backoff grows and is capped at 15s", () => {
  const at = (n: number) => backoffWithJitter(n, () => 0.5);
  expect(at(0)).toBeLessThan(at(1));
  expect(at(1)).toBeLessThan(at(2));
  for (let n = 0; n < 20; n++) expect(backoffWithJitter(n, () => 1)).toBeLessThanOrEqual(15_000);
});

test("jitter spreads retries rather than synchronising them", () => {
  // Two clients reconnecting after the same herdr restart must not retry in
  // lockstep, so the delay must depend on the random source.
  expect(backoffWithJitter(4, () => 0)).not.toBe(backoffWithJitter(4, () => 1));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/keeper.test.ts`
Expected: FAIL — cannot resolve `@server/herdr/keeper`.

- [ ] **Step 3: Implement the keeper**

Create `src/server/herdr/keeper.ts`:

```ts
import { ProtocolMismatchError } from "@server/herdr/socket";

/** Exponential backoff with full jitter, capped at 15s (spec §7). */
export function backoffWithJitter(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(15_000, 500 * 2 ** attempt);
  return Math.round(random() * ceiling);
}

export interface StreamKeeperOptions {
  /** Supervisor.refresh — reconcile, then re-subscribe naming the live panes. */
  refresh: () => Promise<void>;
  backoff?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called for an error that retrying can never fix. */
  onFatal?: (err: Error) => void;
}

export class StreamKeeper {
  private running = false;
  private stopped = false;
  private tries = 0;
  private loop: Promise<void> = Promise.resolve();

  constructor(private readonly opts: StreamKeeperOptions) {}

  get reconnecting(): boolean { return this.running; }
  get attempts(): number { return this.tries; }

  /** Await the current retry loop. Exposed for tests and shutdown. */
  settled(): Promise<void> { return this.loop; }

  stop(): void { this.stopped = true; }

  /**
   * The stream dropped. Idempotent: repeated calls while a retry loop is
   * already running are ignored, so a flapping socket cannot spawn a loop per
   * drop and hammer herdr.
   */
  notifyClosed(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.loop = this.run().finally(() => { this.running = false; });
  }

  private async run(): Promise<void> {
    const backoff = this.opts.backoff ?? backoffWithJitter;
    const sleep = this.opts.sleep ?? ((ms: number) => Bun.sleep(ms));

    for (let attempt = 0; !this.stopped; attempt++) {
      this.tries++;
      try {
        await this.opts.refresh();
        console.info("herdr: event stream recovered", { attempts: this.tries });
        return;
      } catch (err) {
        // A version mismatch cannot be retried into success. Surface it.
        if (err instanceof ProtocolMismatchError) {
          console.error(err.message);
          this.opts.onFatal?.(err);
          return;
        }
        console.error("herdr: reconnect attempt failed", { attempt, err });
        await sleep(backoff(attempt));
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/keeper.test.ts`
Expected: 6 PASS.

- [ ] **Step 5: Wire it into the entry point**

In `src/server/index.ts`, drive the keeper from the stream's `onStateChange`,
replacing the existing `onStateChange` body:

```ts
let keeper: StreamKeeper | null = null;

const stream = new HerdrStream({
  path: socketPath,
  onEvent: (e) => supervisor?.handleEvent(e),
  onStateChange: (up) => {
    herdrConnected = up;
    console.info(`herdr event stream ${up ? "connected" : "disconnected"}`);
    // A drop we did not ask for: start recovering.
    if (!up) keeper?.notifyClosed();
  },
});

// ...after `supervisor` is constructed:
keeper = new StreamKeeper({
  refresh: () => supervisor!.refresh(),
  onFatal: () => process.exit(1),
});
```

Add the import:

```ts
import { StreamKeeper } from "@server/herdr/keeper";
```

- [ ] **Step 6: Verify recovery against a real herdr restart**

This is the only step that proves the task. `/api/health` must go back to
reporting a live `lastEventAt` without restarting paddock:

```bash
make dev &
curl -s localhost:8787/api/health          # note agents + lastEventAt
herdr server stop && sleep 2 && herdr      # restart herdr, then detach
sleep 20
curl -s localhost:8787/api/health          # agents repopulated, herdrConnected true
```

Expected: after the restart, `herdrConnected` returns to `true` and `agents`
matches `herdr agent list` again, with no paddock restart.

⚠️ `herdr server stop` kills every pane process in the session. Run this on a
scratch herdr session, never the one running your real agents.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean
git add src/server/herdr/keeper.ts tests/keeper.test.ts src/server/index.ts
git commit -m "feat: recover the herdr event stream after a herdr restart"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §2 Architecture, modules | 4, 5, 6, 7, 9, 10 |
| §3 Socket transport, protocol guard | 4 |
| §3 Per-pane subscriptions, dual event names | 4, 9 |
| §3 Generated types | 3 |
| §3 `agent.list` not `pane.list` | 5, 9 |
| §3 Five states, filtering `unknown` | 5 |
| §4 Data model | 5 |
| §5 Approve path | **deferred to v2** — probed in Task 2 |
| §6 Triage layout, dense rows, chips | 13 |
| §6 Visual style, tokens, light mode | 11 |
| §6 Motion, reduced-motion | 11 |
| §6 Capability-not-device responsive | 11, 14 |
| §6 Safe-area insets | 11, 13 |
| §7 Connection lifecycle, staleness | 12, 13 |
| §8 Repo layout | 1, 15 |
| §9 Commands, CLI shape, Docker, security | 1, 10, 15 |
| §10 Public-repo hygiene | 1, 8 |
| §11 Performance decisions | 7, 11, 15 |
| §12 Failure modes | 5, 10, 12, 14 |
| §13 Roadmap | 15 |

**Gaps, stated rather than hidden:**
- **Web Push** is spec §13 backlog, deliberately not planned. No service worker ships in v1, so the `sw.js` reasoning is documented but untested in practice.
- **Agent detail sheet / side panel** (§6 component tree) is deferred to v2, since its only content is output and actions.
- **Herdr socket reconnect** — closed by **Task 16**, which was added after the first pass of this review flagged it as a real v1 hole. `ProtocolMismatchError` is deliberately excluded from retry: it is permanent, and looping on it would bury the real cause under reconnect noise.
- **PWA icons** are an empty array in the manifest. Installable but unbranded.

**2. Placeholder scan** — no TBD/TODO. Every code step contains runnable code. Task 2 is a spike whose deliverable is explicitly a written finding, and Task 15 step 9 specifies each doc's required content rather than its prose.

**3. Type consistency** — verified across tasks: `Agent`/`AgentState`/`ServerMessage`/`Section` (Task 5) are used unchanged in 6, 7, 12, 13. `Delta` (Task 6) is consumed by 7, 9 and returned by `store.remove()`. `HubClient` (Task 7) is used in 10. `HerdrAgentRaw`/`HerdrWorkspaceRaw`/`HerdrStatusChanged`/`HerdrEvent` (Task 3) are consumed by 4, 5, 9. `toAgent`/`applyStatusEvent`/`workspaceLabels` (Task 5) are called in 9 with matching signatures. `Subscription` and the `EVENT_*` constants (Task 4) are consumed by 9, 10 and 16. `HerdrClientLike` (Task 9) is satisfied by the `{ request, openStream }` object built in Task 10. `HealthBody` gains `staticDir` on `AppDeps` in Task 15 — an additive change to Task 10's interface, called out in that task's steps.

---

## Corrections applied after live verification

The socket facts in this plan were originally derived from a mix of sample
responses and a reading of the schema. They were re-verified against a running
herdr 0.8.0, and four were wrong. They are recorded here because each one would
have failed at a different, and progressively more expensive, moment.

| Was | Actually | Would have surfaced as |
|---|---|---|
| `events.subscribe` with `{type: "pane.agent_status_changed"}` | Rejected — `pane_id` is required; subscriptions are per-pane | Task 9 runs; no events ever arrive; push silently degrades to the 30s poll |
| One long-lived connection multiplexing requests by `id` | herdr closes a connection after **one** response | Task 4's tests pass against a too-permissive fake, then every second request fails against real herdr |
| Three subscribable event types | 27; `pane.closed` and `pane.agent_detected` among them | Closed agents linger on screen until a reconcile; no live signal for new ones |
| `agent.list` returns 15 fields | `AgentInfo` has 22; a sample response omits absent optionals | A field read as `undefined` with no error |

The lesson worth keeping: **the original Task 4 test fake kept its connection
open, so it validated the client against the mistake rather than against
herdr.** A fake that is more permissive than the real dependency will certify
whatever it is handed. Task 4 now models the hang-up, and Tasks 4 and 16 each
end with a step that runs against the real socket.
