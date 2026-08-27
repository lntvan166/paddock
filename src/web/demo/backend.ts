import type { Agent, AgentState, HealthBody, ServerMessage, SettingsView } from "@shared/types";
import { diffScreens, digestOf } from "@shared/screen";
import { DEMO_JOURNAL_AGENT_ID, DEMO_JOURNAL_LINES } from "@shared/demo-history";
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

const SEED: Array<{ id: string; name: string; task: string; state: AgentState; ageMs: number; harness: string }> = [
  // A mix of harnesses, not all "claude" — this seed is what README
  // screenshots come from, and a mix is what exercises the tile's
  // per-harness colouring.
  { id: "d1:p1", name: "schema-migration", task: "Apply migration to staging", state: "blocked", ageMs: 120_000, harness: "claude" },
  { id: "d2:p1", name: "lint-config", task: "Align eslint with the style guide", state: "done", ageMs: 300_000, harness: "codex" },
  { id: "d3:p1", name: "api-refactor", task: "Extract auth middleware", state: "working", ageMs: 15_000, harness: "claude" },
  { id: "d4:p1", name: "perf-audit", task: "Profile the request path", state: "working", ageMs: 45_000, harness: "codex" },
  { id: "d5:p1", name: "docs-cleanup", task: "Rewrite the getting-started guide", state: "idle", ageMs: 900_000, harness: "claude" },
  { id: "d6:p1", name: "flaky-test-fix", task: "Stabilise the upload suite", state: "idle", ageMs: 3_600_000, harness: "codex" },
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
  harness: s.harness,
  stateSince: Date.now() - s.ageMs, stateSinceExact: true,
  updatedAt: Date.now(),
  acknowledgedAt: null,
  // Only ONE seeded agent claims a journal. The point of this fixture is to
  // demonstrate both paths side by side — "Show earlier" reading a real log
  // vs. falling back to client-side reconstruction — not to pretend every
  // demo agent has one. `DEMO_JOURNAL_AGENT_ID` and the transcript below are
  // shared with `server/demo.ts` (the CLI's `--demo` backend) so both hosts
  // tell the same invented story rather than two that could drift.
  hasJournal: s.id === DEMO_JOURNAL_AGENT_ID,
}));

/**
 * A settings view with nothing configured.
 *
 * Deliberately unconfigured: `configured: false` and a null hint keep any
 * token-shaped string out of the demo bundle, and out of every screenshot taken
 * from it. `scripts/check-private.sh` scans for that shape.
 */
function demoSettings(mutedUntil: number | null = null): SettingsView {
  return {
    telegram: { configured: false, hint: null, chatId: null },
    notify: {
      telegram: false,
      triggers: ["blocked"],
      settleMs: { blocked: 5_000, done: 10_000 },
      mutedUntil,
      cooldownMs: 60_000,
      // Matches `defaults().notify.skipWhileViewing` in settings/store.ts —
      // the demo is a fresh install's settings view, and a fresh install now
      // starts with this on.
      skipWhileViewing: true,
    },
    // No keypair, because the demo is a static bundle with no server behind it
    // — there is nothing to subscribe TO. A null public key is the honest
    // answer and renders as "this server has push turned off" rather than an
    // enable button that could only fail.
    push: { enabled: false, devices: 0, vapidPublicKey: null, error: null },
    publicUrl: null,
    // No tunnel: a paddock served the ordinary way has none, and the demo must
    // not offer to pair a device it cannot pair.
    tunnel: null,
    serverNow: Date.now(),
    error: null,
  };
}

/** Health for the diagnostics card. Invented, and named like the demo host. */
function demoHealth(): HealthBody {
  return {
    ok: true,
    hostId: HOST_ID,
    agents: agents.length,
    clients: 1,
    herdrConnected: true,
    lastEventAt: Date.now(),
    lastNotifyError: null,
    version: "0.0.0-demo",
    latestKnown: null,
    managedBy: null,
    herdrProtocol: 20,
    schemaWarning: null,
  };
}

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

function handle(url: string, body: Record<string, unknown>, method: string): Response {
  // The demo is the only sanctioned source of screenshots, so every screen the
  // product has must render here — including settings, which needs a whole
  // SettingsView before it will paint at all.
  //
  // Path, not substring: "/api/settings" is a prefix of
  // "/api/settings/telegram/test" and "/api/settings/mute", so a substring
  // match answered both of those with a settings view — which made the test
  // button render an empty error banner and Mute silently do nothing.
  const path = url.split("?")[0] ?? url;

  /**
   * Every write, refused in the same words the server-side demo uses.
   *
   * `src/server/demo-actions.ts` REFUSES rather than resolving quietly, and
   * `CLAUDE.md` explains why at length: a write that resolved would make every
   * control look live and do nothing, silently, with no test able to notice
   * because a resolved promise is what success looks like. The browser demo
   * has to hold the same line.
   */
  const refuse = () =>
    json({ ok: false, detail: "this is the demo — paddock has no herdr here, so nothing was sent" }, 409);

  if (path.endsWith("/api/settings/telegram/test")) {
    // The real route reports whether the token and chat id actually work.
    // The demo has no bot, and saying so is more honest than claiming success.
    return json({ ok: false, detail: "The demo has no Telegram bot configured." });
  }
  if (path.endsWith("/api/settings/mute")) {
    // The real route stamps the instant server-side from a client-supplied
    // duration and returns the updated view, so the countdown has something to
    // render. Computed, not persisted: the demo has no store, and a mute that
    // appeared to fail would read as a product bug rather than a demo's limit.
    const forMs = typeof body.forMs === "number" ? body.forMs : 0;
    return json(demoSettings(forMs > 0 ? Date.now() + forMs : null));
  }
  if (path.endsWith("/api/settings")) {
    // A PUT returns the same unconfigured view rather than the patch: the demo
    // has no store, and keeping it unconfigured regardless of what anyone types
    // is what keeps a token-shaped string out of every screenshot taken here.
    return json(demoSettings());
  }
  if (path.endsWith("/api/health")) return json(demoHealth());

  /**
   * The space tree, derived from the SAME `agents` array the dashboard reads.
   *
   * It had no route at all, so `/api/spaces` fell through to the agent regex
   * below and answered 404 — the Spaces screen rendered an error on the hosted
   * demo, which is the one place people look at paddock without running it.
   * The pager made that worse rather than revealed it: all three tabs are
   * mounted now, so the error was there whether or not anyone opened Spaces.
   *
   * Derived rather than hand-written, so the two screens cannot disagree about
   * how many agents exist. Each seeded agent sits in its own space, which is
   * what `workspaceId` already says.
   */
  if (path.endsWith("/api/spaces")) {
    if (method === "POST") return refuse();
    return json({
      readAt: Date.now(),
      spaces: agents.map((a) => ({
        spaceId: a.workspaceId,
        label: a.name,
        tabCount: 1,
        paneCount: 1,
        tabs: [{
          tabId: `${a.workspaceId}:t1`,
          label: null,
          panes: [{
            paneId: a.agentId,
            harness: a.harness,
            name: a.name,
            title: null,
            // Tilde-ised, like `toSpaceTree` does — the create sheet's folder
            // field round-trips this form, so a raw path would come back wrong.
            cwd: "~/work/demo",
            state: a.state,
          }],
        }],
      })),
    });
  }

  /**
   * Every harness the create sheet offers. Without it the picker renders empty
   * and the sheet looks broken rather than restricted.
   */
  if (path.endsWith("/api/harnesses")) return json({ kinds: ["claude", "codex"] });

  // Space and tab management. All writes, all refused — see `refuse`.
  if (/\/api\/(spaces|tabs)\/[^/]+\/\w+/.test(path)) return refuse();

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
      ok: true, lines: DEMO_JOURNAL_LINES, source: "journal", hasMore: false, cursor: null, detail: null,
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
    // The METHOD matters now: `/api/spaces` is a read on GET and a create on
    // POST, and the demo must answer one and refuse the other.
    const method = (init?.method ?? (typeof input === "object" && "method" in input
      ? (input as Request).method
      : "GET")).toUpperCase();
    return handle(url, body, method);
  }) as typeof fetch;

  (globalThis as { WebSocket: unknown }).WebSocket = DemoSocket;

  setInterval(() => { tick++; }, 250);
  setInterval(() => {
    push({ type: "heartbeat", serverTime: Date.now(), build: "demo" });
  }, 20_000);
}
