import type { HerdrActions } from "@server/herdr/actions";
import type { DialogIo } from "@server/herdr/dialog-type";
import type { JournalReader } from "@server/journal/read";
import { stripAnsi } from "@server/journal/text";
import { MAX_TEXT_LEN } from "@server/limits";
import { answerQuestion } from "@server/mcp/answer";
import { describeBlocked, type BlockedInfo } from "@server/mcp/blocked";
import { hasTag, newTag as randomTag, REMOTE_PREFIX, replyAfter } from "@server/mcp/reply";
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
  /** Injected in tests; the defaults are the spec's values. */
  newTag?: () => string;
  now?: () => number;
  maxWaitMs?: number;
  startGraceMs?: number;
  /** How long one sleep on the watch lasts before the journal is re-read. */
  pollMs?: number;
}

/** One wait stays under Cloudflare's ~100 s idle cutoff (a 524). */
export const MAX_WAIT_S = 90;
export const START_GRACE_MS = 10_000;
const POLL_MS = 2_000;
const TAG_RE = /^[0-9a-z]{6}$/;

export type WaitOutcome =
  | { status: "finished"; reply: string[]; source: "journal" | "screen" }
  | { status: "blocked"; blocked: BlockedInfo; note: string }
  | { status: "still_working" }
  | { status: "never_started" };

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

function blockedNote(b: BlockedInfo): string {
  return b.kind === "question"
    ? "The agent asked a question. answer_question can answer it."
    : "The agent is on a permission prompt. Only the operator can answer it, in the paddock UI.";
}

async function blockedOutcome(deps: BridgeDeps, id: string): Promise<WaitOutcome> {
  const blocked = describeBlocked(await deps.actions.readPromptScreen(id));
  return { status: "blocked", blocked, note: blockedNote(blocked) };
}

/**
 * Wait until the tagged message has been answered, the agent stops on a
 * prompt, or `waitMs` runs out.
 *
 * Finished is defined by the JOURNAL, not by the state edge alone: the tagged
 * user turn followed by an agent turn, with the agent no longer working. A
 * state edge on its own would be fooled by a message queued behind a running
 * task, whose end looks exactly like this message's end. Only an agent with no
 * journal falls back to the edge — and `send_message` refuses to wait on such
 * an agent while it is busy, which is the one case the edge cannot tell apart.
 */
async function waitFor(
  deps: BridgeDeps, id: string, tag: string, waitMs: number, sentAt: number | null,
): Promise<ToolResult> {
  const now = deps.now ?? Date.now;
  const grace = deps.startGraceMs ?? START_GRACE_MS;
  const deadline = now() + Math.min(waitMs, deps.maxWaitMs ?? MAX_WAIT_S * 1000);
  let seenWorking = false;

  for (;;) {
    const a = findAgent(deps, id);
    if (!a) return refuse("agent is gone");
    if (a.state === "working") seenWorking = true;
    if (a.state === "blocked") return { ok: true, data: await blockedOutcome(deps, id) };

    if (a.hasJournal && deps.journal) {
      const page = await deps.journal.read(deps.sessionFor?.(id) ?? null, null, 200);
      const lines = page.source === "journal" ? page.lines : [];
      // The agent took the message in, even if the state edge was missed.
      if (hasTag(lines, tag)) seenWorking = true;
      const reply = replyAfter(lines, tag);
      if (reply !== null && a.state !== "working") {
        return { ok: true, data: { status: "finished", reply, source: "journal" } satisfies WaitOutcome };
      }
    } else if (a.state !== "working" && (seenWorking || sentAt === null)) {
      const out = await deps.actions.readOutput(id, a.state);
      return { ok: true, data: { status: "finished", reply: out.lines.map(stripAnsi), source: "screen" } satisfies WaitOutcome };
    }

    if (sentAt !== null && !seenWorking && now() - sentAt > grace) {
      return { ok: true, data: { status: "never_started" } satisfies WaitOutcome };
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { ok: true, data: { status: "still_working" } satisfies WaitOutcome };

    const next = await deps.watch.until(id, (s) => s.state !== a.state, Math.min(remaining, deps.pollMs ?? POLL_MS));
    if (next === "gone") return refuse("agent is gone");
    if (next !== "timeout" && next.state === "working") seenWorking = true;
  }
}

function waitSeconds(v: unknown, min: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= MAX_WAIT_S ? v : null;
}

/** `mcp: <tool> <id> <outcome> len=<n>` — the audit line. Never the text. */
function logged(deps: BridgeDeps, tool: ToolDef): ToolDef {
  const log = deps.log ?? console.info;
  return {
    ...tool,
    call: async (args) => {
      const r = await tool.call(args);
      const d = r.ok ? (r.data as Record<string, unknown> | null) : null;
      const outcome = !r.ok ? "refused"
        : typeof d?.status === "string" ? d.status
        : d?.answered === true ? "answered"
        : d?.sent === true ? "sent"
        : "ok";
      const len = typeof args.text === "string" ? args.text.length
        : typeof args.option === "string" ? args.option.length : 0;
      log(`mcp: ${tool.name} ${typeof args.id === "string" ? args.id : "-"} ${outcome} len=${len}`);
      return r;
    },
  };
}

export function bridgeTools(deps: BridgeDeps): ToolDef[] {
  return toolList(deps).map((t) => logged(deps, t));
}

function toolList(deps: BridgeDeps): ToolDef[] {
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
    {
      name: "send_message",
      description:
        "Send a message to an agent, as if typed into it. It is marked [from remote #<cursor>] so nobody " +
        "mistakes it for the operator. Refused while the agent is blocked on any prompt: permission prompts " +
        "are the operator's, and questions go through answer_question. With wait_seconds (≤ 90), also waits " +
        "for the reply; if the result is still_working, call wait_for_agent with the returned cursor.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          wait_seconds: { type: "integer", minimum: 0, maximum: MAX_WAIT_S, default: 0 },
        },
        required: ["id", "text"], additionalProperties: false,
      },
      call: async (args) => {
        const tag = (deps.newTag ?? randomTag)();
        const text = args.text;
        if (typeof text !== "string" || text.trim() === "") return refuse("text must be a non-empty string");
        if (REMOTE_PREFIX(tag).length + text.length > MAX_TEXT_LEN) {
          return refuse(`text is too long (the limit is ${MAX_TEXT_LEN - REMOTE_PREFIX(tag).length} characters)`);
        }
        const wait = waitSeconds(args.wait_seconds ?? 0, 0);
        if (wait === null) return refuse(`wait_seconds must be an integer from 0 to ${MAX_WAIT_S}`);

        // Read the state as late as possible. What remains is the window
        // between this read and herdr typing the text; closing it would need
        // herdr to refuse a prompt to a blocked agent itself.
        const a = findAgent(deps, args.id);
        if (!a) return refuse(`unknown agent: ${String(args.id)}`);
        if (a.state === "blocked") {
          const b = describeBlocked(await deps.actions.readPromptScreen(a.agentId));
          const options = b.options.length > 0 ? ` Options: ${b.options.join(" / ")}.` : "";
          return refuse(
            `agent is waiting on a prompt, so nothing was sent: ${b.question ?? "(question not parsed)"}${options} ` +
            blockedNote(b),
          );
        }
        if (wait > 0 && a.state === "working" && !(a.hasJournal && deps.journal)) {
          return refuse(
            "this agent has no journal, so a reply can't be matched to this message while it is busy; " +
            "send without waiting, or wait until it is idle. Nothing was sent.",
          );
        }

        const sentAt = (deps.now ?? Date.now)();
        try {
          await deps.actions.sendReply(a.agentId, REMOTE_PREFIX(tag) + text);
        } catch (err) {
          return refuse(err instanceof Error ? err.message : String(err));
        }
        if (wait === 0) return { ok: true, data: { sent: true, cursor: tag } };
        const r = await waitFor(deps, a.agentId, tag, wait * 1000, sentAt);
        return r.ok ? { ok: true, data: { sent: true, cursor: tag, ...(r.data as object) } } : r;
      },
    },
    {
      name: "wait_for_agent",
      description:
        "Wait (≤ 90 s per call) for the reply to a message sent with send_message, identified by its cursor. " +
        "Returns finished with the reply, blocked (with the prompt and whether answer_question can answer it), " +
        "or still_working — then call again. Returns at once if the reply is already there.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          cursor: { type: "string" },
          wait_seconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_S },
        },
        required: ["id", "cursor", "wait_seconds"], additionalProperties: false,
      },
      call: async (args) => {
        const a = findAgent(deps, args.id);
        if (!a) return refuse(`unknown agent: ${String(args.id)}`);
        if (typeof args.cursor !== "string" || !TAG_RE.test(args.cursor)) {
          return refuse("cursor must be the one send_message returned");
        }
        const wait = waitSeconds(args.wait_seconds, 1);
        if (wait === null) return refuse(`wait_seconds must be an integer from 1 to ${MAX_WAIT_S}`);
        return waitFor(deps, a.agentId, args.cursor, wait * 1000, null);
      },
    },
    {
      name: "answer_question",
      description:
        "Answer a question the agent asked (its AskUserQuestion dialog), by the option's exact label from " +
        "read_agent, or with text when the question has a free-text answer. Refuses permission prompts: only " +
        "the operator answers those. Multi-question dialogs are answered one question per call; the result's " +
        "next field shows the next question, or the Submit tab, which is answered the same way.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, option: { type: "string" }, text: { type: "string" } },
        required: ["id"], additionalProperties: false,
      },
      call: async (args) => {
        if (typeof args.id !== "string") return refuse("id must be a string");
        return answerQuestion(deps.store, args.id, { option: args.option, text: args.text }, deps.dialogIo);
      },
    },
  ];
}
