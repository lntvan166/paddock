import type { Agent, AgentState, ServerMessage } from "@shared/types";
import { diffScreens, digestOf } from "@shared/screen";
import {
  blockedScreen, DEMO_OPTIONS, DONE_SCREEN, IDLE_DOCS_SCREEN, SCREENS, WORKING_SCREEN,
} from "@web/demo/screens";

/**
 * A synthetic paddock backend that runs entirely in the browser.
 *
 * GitHub Pages serves static files: there is no Bun server, no WebSocket
 * endpoint and no herdr socket. So the demo replaces `fetch` and `WebSocket`
 * at boot and answers the same routes the real server does, which means the
 * UI runs completely unmodified — no demo branches in components, no `if
 * (demo)` anywhere in the product code, and therefore no way for the demo to
 * quietly diverge from the thing it is demonstrating.
 *
 * What it CANNOT show is honest to state: it demonstrates the interface, not
 * the herdr integration. Nothing here proves paddock can talk to a real agent.
 *
 * Every name, path and line of output is invented — see `demo/screens.ts`.
 */

const HOST_ID = "demo-box";

/** The one seeded agent whose session log the demo can "read" — see `DEMO_HISTORY`. */
const JOURNAL_AGENT_ID = "d6:p1";

const SEED: Array<{ id: string; name: string; task: string; state: AgentState; ageMs: number }> = [
  { id: "d1:p1", name: "schema-migration", task: "Apply migration to staging", state: "blocked", ageMs: 120_000 },
  { id: "d2:p1", name: "lint-config", task: "Align eslint with the style guide", state: "done", ageMs: 300_000 },
  { id: "d3:p1", name: "api-refactor", task: "Extract auth middleware", state: "working", ageMs: 15_000 },
  { id: "d4:p1", name: "perf-audit", task: "Profile the request path", state: "working", ageMs: 45_000 },
  { id: "d5:p1", name: "docs-cleanup", task: "Rewrite the getting-started guide", state: "idle", ageMs: 900_000 },
  { id: "d6:p1", name: "flaky-test-fix", task: "Stabilise the upload suite", state: "idle", ageMs: 3_600_000 },
];

const agents: Agent[] = SEED.map((s) => ({
  hostId: HOST_ID,
  agentId: s.id,
  name: s.name,
  task: s.task,
  state: s.state,
  workspaceId: s.id.split(":")[0]!,
  workspaceLabel: null,
  cwd: "/work/demo",
  stateSince: Date.now() - s.ageMs,
  updatedAt: Date.now(),
  acknowledgedAt: null,
  // Only ONE seeded agent claims a journal. The point of this fixture is to
  // demonstrate both paths side by side — "Show earlier" reading a real log
  // vs. falling back to client-side reconstruction — not to pretend every
  // demo agent has one.
  hasJournal: s.id === JOURNAL_AGENT_ID,
}));

/**
 * A short canned transcript for the one demo agent that has a journal.
 *
 * Invented content, per house rule 2 — never copied from a real session. It
 * exists so `Show earlier` is demonstrable in the mode README screenshots come
 * from, rather than being a feature only a live herdr can show.
 */
const DEMO_HISTORY: string[] = [
  "you · 13:04",
  "the flaky-test-fix suite times out about one run in five — can you dig in?",
  "",
  "agent · 13:05",
  "▸ Bash · run the suite three times",
  "Reproduced it on the second run: the retry budget is exhausted before the " +
    "first assertion fires, so the harness treats a slow fixture boot as a failure.",
  "",
  "you · 13:08",
  "is it the fixture or the assertion timeout?",
  "",
  "agent · 13:09",
  "▸ Read · tests/fixtures/upload.ts",
  "The fixture waits on a fake clock that only advances on tick(); the suite's " +
    "timeout is real wall time. Bumping the tick interval should fix it without " +
    "touching the assertion.",
  "",
];

/** Cursor position on the blocked agent's menu, moved by the arrow keys. */
let cursor = 0;
/** Screens keyed by agent, so a key press can change what the pane shows. */
const screens: Record<string, string[]> = { ...SCREENS };
/** Recent screens per agent, so `since` can be answered with a patch. */
const recent = new Map<string, { digest: string; lines: string[] }[]>();

function screenFor(id: string): string[] {
  if (id === "d1:p1") return blockedScreen(cursor);
  return screens[id] ?? IDLE_DOCS_SCREEN;
}

/**
 * The working agents' spinner and token counter advance on a timer, so the
 * demo shows the thing the whole refresh design exists for: a screen where
 * one line changes and sixty-two do not.
 */
let tick = 0;
function liveScreen(id: string): string[] {
  const base = screenFor(id);
  if (id !== "d3:p1" && id !== "d4:p1") return base;
  const secs = 72 + Math.floor(tick / 4);
  const tokens = (3.4 + tick / 40).toFixed(1);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
  return base.map((l) =>
    l.includes("Refactoring…")
      ? `[38;2;136;136;136m${frames[tick % frames.length]} Refactoring… (${Math.floor(secs / 60)}m ${secs % 60}s · ↓ ${tokens}k tokens)[0m`
      : l,
  );
}

function remember(id: string, digest: string, lines: string[]): void {
  const held = recent.get(id) ?? [];
  if (held[0]?.digest === digest) return;
  recent.set(id, [{ digest, lines }, ...held].slice(0, 8));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function handle(url: string, body: Record<string, unknown>): Response {
  const m = /\/api\/agents\/([^/]+)\/(\w+)/.exec(url);
  if (!m) return json({ ok: false, detail: "not found" }, 404);
  const id = decodeURIComponent(m[1]!);
  const route = m[2]!;
  const agent = agents.find((a) => a.agentId === id);
  if (!agent) return json({ ok: false, detail: "unknown agent" }, 404);

  if (route === "output") {
    const lines = liveScreen(id);
    const digest = digestOf(lines);
    remember(id, digest, lines);
    const since = typeof body.since === "string" ? body.since : null;
    if (since === digest) return json({ unchanged: true });
    if (since) {
      const base = recent.get(id)?.find((s) => s.digest === since)?.lines;
      if (base) return json({ patch: diffScreens(base, lines), source: "visible" });
    }
    return json({ lines, source: "visible", digest });
  }

  if (route === "prompt") {
    if (agent.state !== "blocked") return json({ question: null, options: null, selected: null, raw: "" });
    return json({
      question: "Do you want to proceed?",
      options: DEMO_OPTIONS.map((o, i) => ({ ...o, selected: i === cursor })),
      selected: `${cursor + 1}. ${DEMO_OPTIONS[cursor]!.label}`,
      raw: liveScreen(id).join("\n"),
    });
  }

  if (route === "key") {
    const key = body.key;
    if (key === "down") cursor = (cursor + 1) % DEMO_OPTIONS.length;
    if (key === "up") cursor = (cursor + DEMO_OPTIONS.length - 1) % DEMO_OPTIONS.length;
    if (key === "enter" && agent.state === "blocked") answer(agent);
    const lines = liveScreen(id);
    remember(id, digestOf(lines), lines);
    return json({
      ok: true, lines, source: "visible", digest: digestOf(lines),
      selected: agent.state === "blocked" ? `${cursor + 1}. ${DEMO_OPTIONS[cursor]!.label}` : null,
    });
  }

  if (route === "text") {
    const lines = liveScreen(id);
    return json({ ok: true, lines, source: "visible", digest: digestOf(lines) });
  }

  if (route === "answer") {
    if (agent.state !== "blocked") {
      return json({ ok: false, detail: `agent is ${agent.state}, no longer blocked` }, 409);
    }
    answer(agent);
    return json({ ok: true });
  }

  if (route === "history") {
    if (!agent.hasJournal) {
      return json({
        ok: true, lines: [], source: "reconstruction", hasMore: false, cursor: null,
        detail: "no journal for this demo agent",
      });
    }
    return json({
      ok: true, lines: DEMO_HISTORY, source: "journal", hasMore: false, cursor: null, detail: null,
    });
  }

  if (route === "ack") {
    if (agent.state !== "done" || agent.acknowledgedAt !== null) {
      return json({ ok: false, detail: "not a fresh done agent" }, 409);
    }
    agent.acknowledgedAt = Date.now();
    push({ type: "delta", upserted: [agent], removedIds: [], serverTime: Date.now() });
    return json({ ok: true });
  }

  return json({ ok: false, detail: "not found" }, 404);
}

/** Answering moves the agent on, exactly as a real one would. */
function answer(agent: Agent): void {
  agent.state = cursor === 2 ? "idle" : "working";
  agent.stateSince = Date.now();
  screens[agent.agentId] = agent.state === "working" ? WORKING_SCREEN : DONE_SCREEN;
  push({ type: "delta", upserted: [agent], removedIds: [], serverTime: Date.now() });
}

// ── the socket ─────────────────────────────────────────────────────────────

const sockets = new Set<{ onmessage?: (e: { data: string }) => void }>();

function push(msg: ServerMessage): void {
  for (const s of sockets) s.onmessage?.({ data: JSON.stringify(msg) });
}

/**
 * Enough of a WebSocket for the store to drive. Not a general implementation —
 * only the surface `web/store.ts` actually touches.
 */
class DemoSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;

  constructor() {
    sockets.add(this as { onmessage?: (e: { data: string }) => void });
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({
          type: "snapshot", hostId: HOST_ID, agents, serverTime: Date.now(), build: "demo",
        } satisfies ServerMessage),
      });
    }, 60);
  }

  send(): void { /* the real socket is server-to-browser only */ }

  close(): void {
    this.readyState = 3;
    sockets.delete(this as { onmessage?: (e: { data: string }) => void });
    this.onclose?.();
  }
}

/** Install the demo backend. Call before the app mounts. */
export function installDemoBackend(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
    let body: Record<string, unknown> = {};
    try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { /* not JSON */ }
    // A touch of latency, so the demo feels like a network rather than a
    // local function call — and so loading states are actually visible.
    await new Promise((r) => setTimeout(r, 40));
    return handle(url, body);
  }) as typeof fetch;

  (globalThis as { WebSocket: unknown }).WebSocket = DemoSocket;

  setInterval(() => { tick++; }, 250);
  setInterval(() => {
    push({ type: "heartbeat", serverTime: Date.now(), build: "demo" });
  }, 20_000);
}
