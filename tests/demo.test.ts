import { expect, test } from "bun:test";
import { DEMO_BLOCKED_AGENT_ID, DEMO_BLOCKED_APP_AGENT_ID, DEMO_HOST_ID, DemoSource, createDemoSource, demoAgents, seedDemo, demoJournalPage, demoSessionFor } from "@server/demo";
import { AgentStore } from "@server/state/store";
import type { Agent, HistoryResult } from "@shared/types";
import { installDemoBackend } from "@web/demo/backend";
import { isCoreId } from "@shared/origin";
import { fetchHistory } from "@web/api";

const NOW = 1_700_000_000_000;

// Asserted as an ALLOWLIST, not a denylist of real names. Listing real names here
// to check they are absent would commit them to a public repo — the guard would
// leak exactly what it guards.
const INVENTED_NAMES = new Set([
  "schema-migration", "lint-config", "api-refactor",
  "perf-audit", "docs-cleanup", "flaky-test-fix",
  // The two app agents (origin "core"), in the app space `docs-site`.
  "release-notes", "changelog-sync",
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

// ── the app's agents in the CLI demo (origin "core") ─────────────────────────

test("the CLI demo has two invented app agents, one blocked, in the app space docs-site", () => {
  const app = demoAgents(NOW).filter((a) => a.origin === "core");
  expect(app.map((a) => a.name).sort()).toEqual(["changelog-sync", "release-notes"]);
  for (const a of app) {
    expect(isCoreId(a.agentId), `${a.agentId} is not a core id`).toBe(true);
    expect(a.workspaceId).toBe("hc.docs-site");
    expect(a.workspaceLabel).toBe("docs-site");
  }
  expect(app.find((a) => a.agentId === DEMO_BLOCKED_APP_AGENT_ID)?.state).toBe("blocked");
});

test("a tick never moves the blocked app agent either", () => {
  // Same reason the blocked TUI agent is pinned: the app's permission prompt
  // is the screen the app half of the demo exists for.
  const src = new DemoSource({ onDelta: () => {}, now: () => NOW });
  for (let i = 0; i < 40; i++) src.tick();
  expect(src.snapshot().find((a) => a.agentId === DEMO_BLOCKED_APP_AGENT_ID)?.state).toBe("blocked");
});

test("each demo tick reaches the store under each agent's own origin", () => {
  // The sink was typed to the literal "herdr", so the app's agents could only
  // have reached the store filed as terminal herdr's — and a later herdr-only
  // replace would have removed them.
  const origins: string[] = [];
  const store = new AgentStore(DEMO_HOST_ID);
  const src = createDemoSource({
    store: {
      replaceAll: (incoming, now, origin) => {
        origins.push(origin);
        for (const a of incoming) expect(a.origin).toBe(origin);
        return store.replaceAll(incoming, now, origin);
      },
    },
    onDelta: () => {},
    now: () => NOW,
  });
  src.tick();
  expect(origins.sort()).toEqual(["core", "herdr"]);
  expect(store.snapshot().filter((a) => a.origin === "core")).toHaveLength(2);
});

// ── the CLI demo's /history answers (server/demo.ts, `paddock --demo`) ──────
//
// `paddock --demo` is the mode CLAUDE.md names for README screenshots. Its
// `/history` route (`routes.ts`) is registered unconditionally and always
// calls whatever `JournalReader` `index.ts` wires in; in demo mode that used
// to be the REAL reader fed a `sessionFor` with no supervisor to ask, so
// every seeded agent answered `source: "reconstruction"` no matter what
// `hasJournal` said. `demoJournalPage`/`demoSessionFor` are what `index.ts`
// wires in instead, confined to the `DEMO` branch — these tests exercise
// that decision directly, the same way the tests above exercise `demoAgents`
// directly rather than booting the whole server.

test("exactly one CLI demo agent has a journal", () => {
  const withJournal = demoAgents(NOW).filter((a) => a.hasJournal);
  expect(withJournal).toHaveLength(1);
});

test("the CLI demo journal answers source: journal with the shared invented transcript", () => {
  const journalAgent = demoAgents(NOW).find((a) => a.hasJournal);
  if (!journalAgent) throw new Error("no seeded demo agent has a journal");

  const page = demoJournalPage(demoSessionFor(journalAgent.agentId));
  expect(page.source).toBe("journal");
  expect(page.lines.length).toBeGreaterThan(3);
  expect(page.lines.join("\n")).toContain("flaky-test-fix");
  // Served whole in one page: no further page for the client to ask for.
  expect(page.hasMore).toBe(false);
  expect(page.cursor).toBeNull();
});

test("a different CLI demo agent still answers reconstruction, unaffected", () => {
  const other = demoAgents(NOW).find((a) => !a.hasJournal);
  if (!other) throw new Error("expected at least one demo agent without a journal");

  expect(demoSessionFor(other.agentId)).toBeNull();
  const page = demoJournalPage(demoSessionFor(other.agentId));
  expect(page.source).toBe("reconstruction");
  expect(page.lines).toEqual([]);
});

test("the CLI demo and the static-build demo agree on which agent has the journal", async () => {
  // Two independent demo hosts (server/demo.ts for `--demo`, web/demo/backend.ts
  // for the static build) must tell the SAME invented story — this is the
  // regression `@shared/demo-history` exists to prevent.
  const savedFetch = globalThis.fetch;
  const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  try {
    installDemoBackend();
    const staticAgents = await demoSnapshotAgents();
    const staticJournalId = staticAgents.find((a) => a.hasJournal)?.agentId;
    const cliJournalId = demoAgents(NOW).find((a) => a.hasJournal)?.agentId;
    expect(staticJournalId).toBeDefined();
    expect(cliJournalId).toBe(staticJournalId);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  }
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

test("a demo tick is reflected in the STORE, not just pushed at browsers", () => {
  // Demo mode used to wire DemoSource.onDelta straight to the hub, so the
  // store was seeded once and never updated again: /api/agents returned
  // startup state forever, and a browser loading the page later got a stale
  // snapshot patched only as the 4s cursor happened to revisit each agent.
  const store = new AgentStore(DEMO_HOST_ID);
  let ticks = 0;
  const src = createDemoSource({ store, onDelta: () => { ticks++; }, now: () => NOW });
  seedDemo(store, src.snapshot(), NOW);

  // NOT `snapshot()[0]`, which is the pinned blocked agent: `tick()` skips it
  // on purpose so the demo always has a permission prompt on screen, and an
  // agent that never moves cannot demonstrate that a move reaches the store.
  // The guarantee this test protects is unchanged — only the subject is.
  const changed = src.snapshot().find((a) => a.agentId !== DEMO_BLOCKED_AGENT_ID)!;
  const before = store.snapshot().find((a) => a.agentId === changed.agentId)!;

  src.tick();

  const after = store.snapshot().find((a) => a.agentId === changed.agentId)!;
  const ticked = src.snapshot().find((a) => a.agentId === changed.agentId)!;
  expect(ticks).toBe(1);
  expect(after.state).toBe(ticked.state);
  expect(after.state).not.toBe(before.state);
});

test("the delta browsers receive in demo mode is the store's own", () => {
  const store = new AgentStore(DEMO_HOST_ID);
  const deltas: { upserted: Agent[]; removedIds: string[] }[] = [];
  const src = createDemoSource({ store, onDelta: (d) => deltas.push(d), now: () => NOW });
  seedDemo(store, src.snapshot(), NOW);

  src.tick();

  expect(deltas).toHaveLength(1);
  for (const a of deltas[0]!.upserted) {
    // Every agent a browser is told about must be findable in the store, or
    // the two would disagree the moment the browser reconnected.
    expect(store.snapshot()).toContainEqual(a);
  }
  expect(deltas[0]!.upserted.length).toBeGreaterThan(0);
});

// ── the browser-only demo backend (GitHub Pages "live demo") ────────────────
//
// This is a SEPARATE synthetic backend from `@server/demo` above: it replaces
// `fetch`/`WebSocket` in the browser so the static site has no server to talk
// to at all. `installDemoBackend` mutates globals Bun shares across every test
// file in this process, so each test here must restore them afterward — a
// leaked stub `fetch` would break an unrelated test that never asked for one.

/** Reads the seeded agent list off the snapshot the demo socket sends. */
async function demoSnapshotAgents(): Promise<Agent[]> {
  return new Promise((resolve) => {
    const Ctor = (globalThis as unknown as { WebSocket: new () => {
      onmessage: ((e: { data: string }) => void) | null;
      close(): void;
    } }).WebSocket;
    const socket = new Ctor();
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data) as { type: string; agents?: Agent[] };
      if (msg.type === "snapshot" && msg.agents) {
        socket.close();
        resolve(msg.agents);
      }
    };
  });
}

test("one demo agent has a journal, so --demo can demonstrate Show earlier", async () => {
  // README screenshots come from --demo. A feature invisible there cannot be
  // screenshotted, and the roadmap already records one such gap (the approve
  // path). Adding a second silently would be a choice, not an accident.
  const savedFetch = globalThis.fetch;
  const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  try {
    installDemoBackend();
    const agents = await demoSnapshotAgents();
    const withJournal = agents.filter((a) => a.hasJournal);
    expect(withJournal).toHaveLength(1);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  }
});

test("the demo journal uses invented content, and other demo agents are unaffected", async () => {
  const savedFetch = globalThis.fetch;
  const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  try {
    installDemoBackend();
    const agents = await demoSnapshotAgents();
    const journalAgent = agents.find((a) => a.hasJournal);
    if (!journalAgent) throw new Error("no seeded demo agent has a journal");
    const other = agents.find((a) => !a.hasJournal);
    if (!other) throw new Error("expected at least one demo agent without a journal");

    const withJournal: HistoryResult = await fetchHistory(journalAgent.agentId, null, 20);
    expect(withJournal.source).toBe("journal");
    expect(withJournal.lines.length).toBeGreaterThan(3);
    expect(withJournal.lines.join("\n")).toContain("flaky-test-fix");

    // A different demo agent must keep behaving exactly as it did before this
    // feature existed: no journal, so the client falls back to its own
    // reconstruction rather than the server pretending to have one.
    const without: HistoryResult = await fetchHistory(other.agentId, null, 20);
    expect(without.source).toBe("reconstruction");
    expect(without.lines).toEqual([]);
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  }
});

test("the phone frame is demo-only, and reaches no bundle an operator runs", async () => {
  // The same rule the demo backend follows, applied to the frame's stylesheet:
  // an operator serving paddock from their own machine downloads none of it.
  // The mechanism is a dynamic import in main.tsx, so the frame is a separate
  // chunk that a normal build never emits — but nothing about that is obvious
  // from reading either file, and a future edit moving the import to the top of
  // main.tsx would ship it silently.
  const { existsSync, readdirSync } = await import("node:fs");

  // The import has to stay dynamic, and has to stay inside the demo branch.
  const main = await Bun.file("src/web/main.tsx").text();
  expect(main).toContain('await import("@web/demo/frame")');
  expect(main).not.toMatch(/^import .*demo\/frame/m);

  // And nothing sets the attribute outside the demo entry, or the CSS would
  // apply to a real install if it ever did ship.
  const frame = await Bun.file("src/web/demo/frame.ts").text();
  expect(frame).toContain("demoFrame");

  // Skipped rather than failed when dist/ is absent: `bun test` alone does not
  // build, and a test that demanded a build would fail for the wrong reason.
  if (!existsSync("dist/assets")) return;
  const leaked = readdirSync("dist/assets").filter((f) => /frame/i.test(f));
  expect(leaked, "the frame chunk is in the operator build").toEqual([]);
  for (const f of readdirSync("dist/assets")) {
    if (!/\.(js|css)$/.test(f)) continue;
    expect(await Bun.file(`dist/assets/${f}`).text(), `${f} carries the frame`)
      .not.toContain("data-demo-frame");
  }
});
