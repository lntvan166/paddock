import { expect, test } from "bun:test";
import type { HerdrActions } from "@server/herdr/actions";
import type { JournalPage, JournalReader } from "@server/journal/read";
import { toLines } from "@server/journal/text";
import { answerQuestion } from "@server/mcp/answer";
import { describeBlocked, isQuestionDialog } from "@server/mcp/blocked";
import { REMOTE_PREFIX } from "@server/mcp/reply";
import { bridgeTools, type BridgeDeps } from "@server/mcp/tools";
import { AgentWatch } from "@server/mcp/watch";
import { AgentStore } from "@server/state/store";
import { proxyHttp } from "@server/tunnel/proxy";
import type { Agent } from "@shared/types";

/**
 * Regressions for the final whole-branch review. Each names the finding.
 */

/** C1's probe: a real permission prompt whose command text carries a tab-bar-shaped line. */
const PERMISSION_WITH_BAR = [
  "Bash command",
  "",
  "   cat > fixture.txt <<'EOF'",
  "   ←  ☐ Tea  ✔ Submit  →",
  "   EOF",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for cat commands",
  "  3. No, and tell Claude what to do differently",
].join("\n");

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "flaky-test-fix", task: "Stabilise the retry test",
    state: "blocked", workspaceId: "w1", workspaceLabel: null, cwd: "/srv/project", harness: "claude",
    stateSince: 0, stateSinceExact: true, updatedAt: 0, acknowledgedAt: null, hasJournal: true, ...over,
  };
}

test("C1: a permission prompt carrying a tab-bar line is never a question", async () => {
  expect(isQuestionDialog(PERMISSION_WITH_BAR)).toBe(false);
  expect(describeBlocked(PERMISSION_WITH_BAR).kind).toBe("permission");

  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], 0);
  const keys: string[] = [];
  const io = {
    readPromptScreen: async () => PERMISSION_WITH_BAR,
    sendNavKey: async (_t: string, k: string) => { keys.push(k); },
    sendChars: async () => { keys.push("chars"); },
    sendOptionKey: async (_t: string, k: string) => { keys.push(`digit:${k}`); },
    settle: async () => {},
  };
  const r = await answerQuestion(store, "w1:p1", { option: "Yes" }, io as never);
  expect(r.ok).toBe(false);
  expect(keys).toEqual([]);
});

test("I1: the publishing proxy never forwards /mcp", async () => {
  // Port 9 (discard) is never a paddock: if this forwarded, it would 502.
  for (const path of ["/mcp", "/mcp/", "/MCP"]) {
    const res = await proxyHttp(new Request(`http://127.0.0.1:1234${path}`, { method: "POST", body: "{}" }), { host: "127.0.0.1", port: 9 });
    expect(res.status).toBe(404);
  }
});

function world(state: Agent["state"], screen: string, journalLines: () => JournalPage) {
  const store = new AgentStore("dev-box");
  const watch = new AgentWatch();
  store.replaceAll([agent({ state })], 0);
  const sent: string[] = [];
  const actions = {
    async readOutput() { return { lines: ["final screen"], source: "visible" as const }; },
    async readPromptScreen() { return screen; },
    async sendReply(_t: string, text: string) { sent.push(text); },
  } as unknown as HerdrActions;
  const journal: JournalReader = { read: async (_s, before) => journalLines.call({ before } as never) };
  const deps: BridgeDeps = {
    store, actions, watch, journal, sessionFor: () => null, dialogIo: actions as never, log: () => {},
    newTag: () => "abc123", maxWaitMs: 200, startGraceMs: 50, pollMs: 20,
  };
  const call = (name: string, args: Record<string, unknown>) =>
    bridgeTools(deps).find((t) => t.name === name)!.call(args) as Promise<any>;
  return { call, sent, deps };
}

const emptyPage = (): JournalPage => ({ lines: [], source: "journal", hasMore: false, cursor: null, detail: null });

test("I2: send_message refuses when a prompt is on screen though the store says working", async () => {
  const w = world("working", "Do you want to proceed?\n❯ 1. Yes\n  2. No\n", emptyPage);
  const r = await w.call("send_message", { id: "w1:p1", text: "carry on" });
  expect(r.ok).toBe(false);
  expect(w.sent).toEqual([]);
});

test("I2: an ordinary working screen still sends", async () => {
  const w = world("working", "Running tests…\n  1. unit\n  2. e2e\n", emptyPage);
  const r = await w.call("send_message", { id: "w1:p1", text: "carry on" });
  expect(r.ok).toBe(true);
  expect(w.sent.length).toBe(1);
});

test("I3: the tag is found by paging back past the latest page", async () => {
  const tagged = toLines([
    { role: "user", at: null, text: `${REMOTE_PREFIX("abc123")}go`, tools: [] },
    { role: "assistant", at: null, text: "Done long ago.", tools: [] },
  ]);
  const recent = toLines([{ role: "user", at: null, text: "later chatter", tools: [] }, { role: "assistant", at: null, text: "ok", tools: [] }]);
  const w = world("idle", "", function (this: { before: number | null }) {
    return this.before === null
      ? { lines: recent, source: "journal", hasMore: true, cursor: "500", detail: null }
      : { lines: tagged, source: "journal", hasMore: false, cursor: null, detail: null };
  });
  const r = await w.call("wait_for_agent", { id: "w1:p1", cursor: "abc123", wait_seconds: 1 });
  expect(r.data.status).toBe("finished");
  expect(r.data.reply).toContain("Done long ago.");
});

test("I3: no journal page for the session falls back to the state edge and the screen", async () => {
  const w = world("idle", "", () => ({ lines: [], source: "reconstruction", hasMore: false, cursor: null, detail: "no session" }));
  const r = await w.call("wait_for_agent", { id: "w1:p1", cursor: "abc123", wait_seconds: 1 });
  expect(r.data).toEqual({ status: "finished", reply: ["final screen"], source: "screen" });
});

test("I4: an error during the wait still returns the cursor of the sent message", async () => {
  const w = world("idle", "", () => { throw new Error("journal unreadable"); });
  const r = await w.call("send_message", { id: "w1:p1", text: "go", wait_seconds: 1 });
  expect(r.ok).toBe(true);
  expect(r.data).toEqual({ sent: true, cursor: "abc123", status: "wait_failed", error: "journal unreadable" });
  expect(w.sent.length).toBe(1);
});
