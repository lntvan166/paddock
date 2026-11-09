import { expect, test } from "bun:test";
import type { HerdrActions } from "@server/herdr/actions";
import type { JournalPage, JournalReader } from "@server/journal/read";
import { describeBlocked } from "@server/mcp/blocked";
import { bridgeTools, type BridgeDeps } from "@server/mcp/tools";
import { AgentWatch } from "@server/mcp/watch";
import { AgentStore } from "@server/state/store";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "idle", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project", harness: "claude",
    stateSince: NOW, stateSinceExact: true, updatedAt: NOW, acknowledgedAt: null, hasJournal: true, origin: "herdr", turn: null, seen: null, ...over,
  };
}

const PERMISSION = "Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";

/** A single-select question dialog, invented content (see tests/ask-dialog.test.ts). */
const QUESTION = [
  "←  ☒ Colours  ☒ Fruit  ✔ Submit  →",
  "",
  "Which is your single favourite fruit?",
  "",
  "❯ 1. Mango",
  "     Sweet, tropical, and unmistakable.",
  "  2. Apple ✔",
  "     Crisp, reliable, available year-round.",
  "  3. Type something.",
  "──────────────────────────────",
  "  4. Chat about this",
].join("\n");

const page = (lines: string[]): JournalPage =>
  ({ lines, source: "journal", hasMore: false, cursor: null, detail: null });

function deps(agents: Agent[], over: { screen?: string; lines?: string[] | null } = {}) {
  const store = new AgentStore("dev-box");
  store.replaceAll(agents, NOW);
  const actions = {
    async readOutput() { return { lines: ["$ make test", "ok"], source: "visible" as const }; },
    async readPromptScreen() { return over.screen ?? PERMISSION; },
  } as unknown as HerdrActions;
  const journal: JournalReader = {
    read: async () => over.lines === null
      ? { lines: [], source: "reconstruction", hasMore: false, cursor: null, detail: "no journal" }
      : page(over.lines ?? ["\x1b[36magent\x1b[0m · 13:04", "Refactor done."]),
  };
  const d: BridgeDeps = {
    store, actions, watch: new AgentWatch(), journal,
    sessionFor: () => null,
    dialogIo: actions as never,
    log: () => {},
  };
  return d;
}

const call = async (d: BridgeDeps, name: string, args: Record<string, unknown> = {}) =>
  bridgeTools(d).find((t) => t.name === name)!.call(args);

test("list_agents returns invented agents with their labels", async () => {
  const r = await call(deps([agent(), agent({ agentId: "w2:p1", name: "docs-cleanup", workspaceLabel: null, workspaceId: "w2", state: "working" })]), "list_agents");
  // Sorted here: the order is the store's (the UI's), not this tool's concern.
  const data = (r as any).data.sort((x: any, y: any) => x.id.localeCompare(y.id));
  expect({ ok: r.ok, data }).toEqual({ ok: true, data: [
    { id: "w1:p1", name: "api-refactor", state: "idle", cwd: "/srv/project", workspace: "api work" },
    { id: "w2:p1", name: "docs-cleanup", state: "working", cwd: "/srv/project", workspace: "w2" },
  ] });
});

test("read_agent: an unknown id is an error", async () => {
  const r = await call(deps([agent()]), "read_agent", { id: "w9:p9" });
  expect(r.ok).toBe(false);
});

test("read_agent: a bad limit is an error", async () => {
  for (const limit of [0, 51, 2.5, "3"]) {
    expect((await call(deps([agent()]), "read_agent", { id: "w1:p1", limit })).ok).toBe(false);
  }
});

test("read_agent prefers the journal and strips ANSI", async () => {
  const r = await call(deps([agent()]), "read_agent", { id: "w1:p1" }) as any;
  expect(r.data).toEqual({ id: "w1:p1", state: "idle", source: "journal", transcript: ["agent · 13:04", "Refactor done."] });
});

test("read_agent keeps only the last `limit` lines", async () => {
  const r = await call(deps([agent()], { lines: ["a", "b", "c"] }), "read_agent", { id: "w1:p1", limit: 2 }) as any;
  expect(r.data.transcript).toEqual(["b", "c"]);
});

test("read_agent falls back to the screen without a journal", async () => {
  const r = await call(deps([agent({ hasJournal: false, origin: "herdr", turn: null, seen: null })]), "read_agent", { id: "w1:p1" }) as any;
  expect(r.data.source).toBe("screen");
  expect(r.data.transcript).toEqual(["$ make test", "ok"]);
});

test("read_agent falls back to the screen when the journal has nothing", async () => {
  const r = await call(deps([agent()], { lines: null }), "read_agent", { id: "w1:p1" }) as any;
  expect(r.data.source).toBe("screen");
});

test("blocked on a permission prompt → kind permission with real labels", async () => {
  const r = await call(deps([agent({ state: "blocked" })]), "read_agent", { id: "w1:p1" }) as any;
  expect(r.data.blocked).toEqual({ kind: "permission", question: "Do you want to proceed?", options: ["Yes", "No"], raw: null });
});

test("blocked on a question dialog → kind question", async () => {
  const r = await call(deps([agent({ state: "blocked" })], { screen: QUESTION }), "read_agent", { id: "w1:p1" }) as any;
  expect(r.data.blocked.kind).toBe("question");
  expect(r.data.blocked.question).toBe("Which is your single favourite fruit?");
  expect(r.data.blocked.options).toContain("Mango");
  expect(r.data.blocked.options).toContain("Apple");
});

test("not blocked → no blocked field", async () => {
  const r = await call(deps([agent()]), "read_agent", { id: "w1:p1" }) as any;
  expect("blocked" in r.data).toBe(false);
});

test("an unparseable blocked screen → permission, options [], raw set", () => {
  expect(describeBlocked("\x1b[1msomething odd\x1b[0m")).toEqual({ kind: "permission", question: null, options: [], raw: "something odd" });
});
