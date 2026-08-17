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
