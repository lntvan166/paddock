import type { HerdrActions } from "@server/herdr/actions";
import type { DialogIo } from "@server/herdr/dialog-type";
import type { JournalReader } from "@server/journal/read";
import { stripAnsi } from "@server/journal/text";
import { describeBlocked } from "@server/mcp/blocked";
import type { ToolDef, ToolResult } from "@server/mcp/protocol";
import type { AgentWatch } from "@server/mcp/watch";
import type { AgentStore } from "@server/state/store";
import type { HerdrAgentSession } from "@shared/herdr-api";
import type { Agent } from "@shared/types";

export interface BridgeDeps {
  store: AgentStore;
  actions: HerdrActions;
  watch: AgentWatch;
  journal?: JournalReader;
  sessionFor?: (agentId: string) => HerdrAgentSession | null;
  /** `{ ...actions, settle }`, built in routes.ts like the dialog routes do. */
  dialogIo: DialogIo;
  /** One INFO line per call. Defaults to console.info. */
  log?: (line: string) => void;
}

const DEFAULT_READ_LIMIT = 20;
const MAX_READ_LIMIT = 50;

const refuse = (error: string): ToolResult => ({ ok: false, error });

export function findAgent(deps: BridgeDeps, id: unknown): Agent | null {
  if (typeof id !== "string") return null;
  return deps.store.snapshot().find((a) => a.agentId === id) ?? null;
}

/**
 * The agent's recent turns, from its journal when it has one, else its screen.
 * ANSI is stripped: the reader is a model, not a terminal.
 */
export async function transcriptOf(
  deps: BridgeDeps, a: Agent, limit: number,
): Promise<{ transcript: string[]; source: "journal" | "screen" }> {
  if (a.hasJournal && deps.journal) {
    const page = await deps.journal.read(deps.sessionFor?.(a.agentId) ?? null, null, 200);
    if (page.source === "journal" && page.lines.length > 0) {
      return { transcript: page.lines.map(stripAnsi).slice(-limit), source: "journal" };
    }
  }
  const out = await deps.actions.readOutput(a.agentId, a.state);
  return { transcript: out.lines.map(stripAnsi).slice(-limit), source: "screen" };
}

export function bridgeTools(deps: BridgeDeps): ToolDef[] {
  return [
    {
      name: "list_agents",
      description:
        "List the coding agents paddock is watching, with their state: working, idle, done, or blocked " +
        "(waiting on a prompt). Use the id with the other tools.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: async () => ({
        ok: true,
        data: deps.store.snapshot().map((a) => ({
          id: a.agentId, name: a.name, state: a.state, cwd: a.cwd, workspace: a.workspaceLabel ?? a.workspaceId,
        })),
      }),
    },
    {
      name: "read_agent",
      description:
        "Read an agent's state and its last turns (from its session journal, else its screen). " +
        "When state is blocked, blocked.kind says whether it is a permission prompt (only the operator " +
        "can answer it, on their phone) or a question the agent asked (answer_question can answer it).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: MAX_READ_LIMIT, default: DEFAULT_READ_LIMIT },
        },
        required: ["id"], additionalProperties: false,
      },
      call: async (args) => {
        const a = findAgent(deps, args.id);
        if (!a) return refuse(`unknown agent: ${String(args.id)}`);
        const limit = args.limit ?? DEFAULT_READ_LIMIT;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
          return refuse(`limit must be an integer from 1 to ${MAX_READ_LIMIT}`);
        }
        const t = await transcriptOf(deps, a, limit);
        const blocked = a.state === "blocked"
          ? { blocked: describeBlocked(await deps.actions.readPromptScreen(a.agentId)) }
          : {};
        return { ok: true, data: { id: a.agentId, state: a.state, ...t, ...blocked } };
      },
    },
  ];
}
