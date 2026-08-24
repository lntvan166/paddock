import type { Agent, AgentState } from "@shared/types";
import type { HerdrAgentSession } from "@shared/herdr-api";
import { DEMO_JOURNAL_AGENT_ID, DEMO_JOURNAL_LINES } from "@shared/demo-history";

export const DEMO_HOST_ID = "demo-box";

/**
 * Synthetic agents for `--demo`. Names are INVENTED — this is the only mode used
 * for screenshots and README media, so it must never resemble real data.
 */
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
    harness: s.harness,
    stateSince: now - s.ageMs,
    updatedAt: now,
    acknowledgedAt: null,
    // Only ONE seeded agent claims a journal, matching `web/demo/backend.ts`
    // (the static build's demo host) exactly — `DEMO_JOURNAL_AGENT_ID` is the
    // single shared source of truth for which one, so both demo hosts
    // demonstrate the same "Show earlier" story rather than two that could
    // drift. `index.ts` wires this agent's `/history` answer in the DEMO
    // branch; this flag is only the client-facing hint (decision 18).
    hasJournal: s.id === DEMO_JOURNAL_AGENT_ID,
  }));
}

/**
 * The shape `server/journal/read.ts`'s real `JournalReader.read` returns —
 * matched structurally rather than imported, so demo.ts (which stands in for
 * herdr, per the note on `DemoStoreSink` below) does not take on a dependency
 * on `journal/`, a separate leaf off the composition root. `index.ts` wraps
 * `demoJournalPage` in an object satisfying the real `JournalReader`
 * interface — the two shapes agreeing is what TypeScript checks for it.
 */
export interface DemoJournalPage {
  lines: string[];
  source: "journal" | "reconstruction";
  hasMore: boolean;
  cursor: string | null;
  detail: string | null;
}

/**
 * The DEMO's whole answer for `/history`: one agent (`DEMO_JOURNAL_AGENT_ID`)
 * gets the shared invented transcript with `source: "journal"` — the field
 * the client actually keys its routing on, not the static `hasJournal` hint
 * (decision 18) — and every other agent gets the same "no journal" shape the
 * real reader sends for a harness with no adapter. Never reads a real file:
 * `index.ts` confines this to the `DEMO` branch, the same way demo mode never
 * opens a real herdr connection.
 *
 * Served whole in one page, so `hasMore: false` and `cursor: null` are the
 * only self-consistent answer — there is no second page to point `cursor` at.
 */
export function demoJournalPage(session: HerdrAgentSession | null | undefined): DemoJournalPage {
  if (!session || session.value !== DEMO_JOURNAL_AGENT_ID) {
    return {
      lines: [], source: "reconstruction", hasMore: false, cursor: null,
      detail: "no journal for this demo agent",
    };
  }
  return { lines: DEMO_JOURNAL_LINES, source: "journal", hasMore: false, cursor: null, detail: null };
}

/**
 * The DEMO's `sessionFor`: a synthetic session ref for the one journal agent,
 * `null` for every other — mirroring what a real `Supervisor.sessionFor`
 * would answer, without a real herdr connection to ask.
 */
export function demoSessionFor(id: string): HerdrAgentSession | null {
  return id === DEMO_JOURNAL_AGENT_ID
    ? { agent: "demo", kind: "id", source: "demo", value: id }
    : null;
}

interface DemoDelta {
  upserted: Agent[];
  removedIds: string[];
}

/**
 * Just enough of AgentStore's shape to apply a tick to it, declared
 * structurally rather than imported. demo.ts stands in for herdr and is
 * therefore upstream of the store; importing `AgentStore` here would point a
 * dependency the wrong way down `herdr → store → hub → web`.
 */
export interface DemoStoreSink {
  replaceAll(incoming: Agent[], now: number): DemoDelta;
}

/**
 * Wire a demo source so every tick lands in the STORE first, then the hub.
 *
 * The store is authoritative in both modes, and demo mode must not be the
 * exception: it is the documented path for screenshots, README media, and
 * evaluating paddock without herdr, so it is the mode outsiders are most
 * likely to see. Feeding DemoSource straight to the hub left `/api/agents`
 * and every newly-loaded browser reading startup state forever, patched only
 * as the 4s cursor happened to revisit each agent.
 */
export function createDemoSource(opts: {
  store: DemoStoreSink;
  onDelta: (d: DemoDelta) => void;
  intervalMs?: number;
  now?: () => number;
}): DemoSource {
  const now = opts.now ?? Date.now;
  const source: DemoSource = new DemoSource({
    intervalMs: opts.intervalMs,
    now: opts.now,
    // The delta forwarded to browsers is the STORE's, not the demo array's,
    // so what a browser is told and what a later /api/agents reports are the
    // same computation.
    onDelta: () => opts.onDelta(opts.store.replaceAll(source.snapshot(), now())),
  });
  return source;
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
    // Spreads `...target` without applying carryAcknowledged, so `next` can
    // carry a stale `acknowledgedAt` into a non-`done` state. Safe only
    // because this object never reaches a browser directly: createDemoSource
    // feeds it through `store.replaceAll`, which applies carryAcknowledged
    // independently on the real Agent it commits. Do not "fix" it here — that
    // would duplicate the rule instead of the store owning it once.
    const next: Agent = { ...target, state, stateSince: now, updatedAt: now };
    this.agents = this.agents.map((a) => (a.agentId === next.agentId ? next : a));
    this.cursor += 1;
    this.opts.onDelta({ upserted: [next], removedIds: [] });
  }
}
