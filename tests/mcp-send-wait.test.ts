import { expect, test } from "bun:test";
import { demoActions } from "@server/demo-actions";
import type { HerdrActions } from "@server/herdr/actions";
import type { JournalReader } from "@server/journal/read";
import { toLines } from "@server/journal/text";
import { REMOTE_PREFIX } from "@server/mcp/reply";
import { bridgeTools, type BridgeDeps } from "@server/mcp/tools";
import { AgentWatch } from "@server/mcp/watch";
import { MAX_TEXT_LEN } from "@server/routes";
import { AgentStore } from "@server/state/store";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;
const TAG = "abc123";
const PERMISSION = "Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "schema-migration",
    task: "Add the orders index", state: "idle", workspaceId: "w1",
    workspaceLabel: null, cwd: "/srv/project", harness: "claude",
    stateSince: NOW, stateSinceExact: true, updatedAt: NOW, acknowledgedAt: null, hasJournal: true, ...over,
  };
}

/** A small world: a store, a watch fed by store changes, and a journal a test appends to. */
function world(start: Partial<Agent> = {}, actionsOver: Partial<HerdrActions> = {}) {
  const store = new AgentStore("dev-box");
  const watch = new AgentWatch();
  store.replaceAll([agent(start)], NOW);
  const sent: string[] = [];
  let lines: string[] = [];
  const setState = (state: Agent["state"]) => {
    const cur = store.snapshot()[0]!;
    watch.observe(store.replaceAll([{ ...cur, state }], NOW));
  };
  const actions = {
    async readOutput() { return { lines: ["screen line"], source: "visible" as const }; },
    async readPromptScreen() { return PERMISSION; },
    async sendReply(_t: string, text: string) { sent.push(text); },
    ...actionsOver,
  } as unknown as HerdrActions;
  const journal: JournalReader = {
    read: async () => ({ lines, source: "journal", hasMore: false, cursor: null, detail: null }),
  };
  const deps: BridgeDeps = {
    store, actions, watch, journal, sessionFor: () => null, dialogIo: actions as never,
    log: () => {}, newTag: () => TAG, maxWaitMs: 300, startGraceMs: 100, pollMs: 20,
  };
  const call = (name: string, args: Record<string, unknown>) =>
    bridgeTools(deps).find((t) => t.name === name)!.call(args) as Promise<any>;
  const reply = (text: string) => {
    lines = toLines([
      { role: "user", at: null, text: `${REMOTE_PREFIX(TAG)}go`, tools: [] },
      { role: "assistant", at: null, text, tools: [] },
    ]);
  };
  const setLines = (l: string[]) => { lines = l; };
  return { store, watch, sent, setState, call, reply, setLines, deps };
}

const later = (ms: number, f: () => void) => setTimeout(f, ms);

test("prefix and tag reach sendReply", async () => {
  const w = world();
  const r = await w.call("send_message", { id: "w1:p1", text: "report docker compose ps" });
  expect(r).toEqual({ ok: true, data: { sent: true, cursor: TAG } });
  expect(w.sent).toEqual(["[from remote #abc123] report docker compose ps"]);
});

test("the length bound includes the prefix", async () => {
  const w = world();
  const fits = "x".repeat(MAX_TEXT_LEN - REMOTE_PREFIX(TAG).length);
  expect((await w.call("send_message", { id: "w1:p1", text: fits })).ok).toBe(true);
  expect((await w.call("send_message", { id: "w1:p1", text: fits + "x" })).ok).toBe(false);
});

test("empty or non-string text is refused", async () => {
  const w = world();
  for (const text of ["", "   ", 3, undefined]) {
    expect((await w.call("send_message", { id: "w1:p1", text })).ok).toBe(false);
  }
  expect(w.sent).toEqual([]);
});

test("blocked on a permission prompt refuses and sends nothing", async () => {
  const w = world({ state: "blocked" });
  const r = await w.call("send_message", { id: "w1:p1", text: "yes" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("waiting on a prompt");
  expect(r.error).toContain("Do you want to proceed?");
  expect(w.sent).toEqual([]);
});

test("blocked on a question dialog also refuses send_message", async () => {
  const QUESTION = "←  ☒ Fruit  ✔ Submit  →\n\nWhich fruit?\n\n❯ 1. Mango\n     Sweet.\n  2. Type something.\n";
  const w = world({ state: "blocked" }, { readPromptScreen: async () => QUESTION } as never);
  const r = await w.call("send_message", { id: "w1:p1", text: "Mango" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("answer_question");
  expect(w.sent).toEqual([]);
});

test("wait_seconds outside 0–90 is refused", async () => {
  const w = world();
  for (const wait_seconds of [-1, 91, 1.5, "5"]) {
    expect((await w.call("send_message", { id: "w1:p1", text: "go", wait_seconds })).ok).toBe(false);
  }
  expect(w.sent).toEqual([]);
});

test("wait returns at once when the tagged reply is already in the journal", async () => {
  const w = world();
  w.reply("Index added.");
  const t0 = Date.now();
  const r = await w.call("wait_for_agent", { id: "w1:p1", cursor: TAG, wait_seconds: 90 });
  expect(r.data).toEqual({ status: "finished", reply: ["Index added."], source: "journal" });
  expect(Date.now() - t0).toBeLessThan(100);
});

test("a working→idle edge without the tag in the journal is not finished", async () => {
  // The queued-behind case: the agent was busy with an earlier task, which ends.
  const w = world({ state: "working" });
  w.setLines(toLines([{ role: "assistant", at: null, text: "the earlier task's answer", tools: [] }]));
  later(30, () => w.setState("idle"));
  const r = await w.call("wait_for_agent", { id: "w1:p1", cursor: TAG, wait_seconds: 1 });
  expect(r.data).toEqual({ status: "still_working" });
});

test("finished after working→idle with the tag", async () => {
  const w = world();
  later(20, () => w.setState("working"));
  later(60, () => { w.reply("Index added."); w.setState("idle"); });
  const r = await w.call("send_message", { id: "w1:p1", text: "go", wait_seconds: 1 });
  expect(r.data).toEqual({ sent: true, cursor: TAG, status: "finished", reply: ["Index added."], source: "journal" });
});

test("not finished while still working, even with a partial reply", async () => {
  const w = world({ state: "working" });
  w.reply("Half way…");
  const r = await w.call("wait_for_agent", { id: "w1:p1", cursor: TAG, wait_seconds: 1 });
  expect(r.data.status).toBe("still_working");
});

test("blocked mid-wait → blocked outcome with kind", async () => {
  const w = world();
  later(20, () => w.setState("working"));
  later(50, () => w.setState("blocked"));
  const r = await w.call("send_message", { id: "w1:p1", text: "go", wait_seconds: 1 });
  expect(r.data.status).toBe("blocked");
  expect(r.data.blocked.kind).toBe("permission");
  expect(r.data.note).toContain("operator");
});

test("still_working at the cap", async () => {
  const w = world({ state: "working" });
  const t0 = Date.now();
  const r = await w.call("wait_for_agent", { id: "w1:p1", cursor: TAG, wait_seconds: 5 });
  expect(r.data).toEqual({ status: "still_working" });
  // maxWaitMs (300) wins over wait_seconds (5 s).
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("never_started after the grace", async () => {
  const w = world();
  const r = await w.call("send_message", { id: "w1:p1", text: "go", wait_seconds: 1 });
  expect(r.data.status).toBe("never_started");
});

test("removal ends the wait", async () => {
  const w = world({ state: "working" });
  later(20, () => w.watch.observe(w.store.replaceAll([], NOW)));
  const t0 = Date.now();
  const r = await w.call("wait_for_agent", { id: "w1:p1", cursor: TAG, wait_seconds: 1 });
  expect(r).toEqual({ ok: false, error: "agent is gone" });
  expect(Date.now() - t0).toBeLessThan(200);
});

test("a malformed cursor is refused", async () => {
  const w = world();
  for (const cursor of ["", "ABC123", "abc12", 7]) {
    expect((await w.call("wait_for_agent", { id: "w1:p1", cursor, wait_seconds: 1 })).ok).toBe(false);
  }
});

test("no-journal agent: waiting on a working send is refused before sending", async () => {
  const w = world({ state: "working", hasJournal: false });
  const r = await w.call("send_message", { id: "w1:p1", text: "go", wait_seconds: 10 });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("no journal");
  expect(w.sent).toEqual([]);
});

test("no-journal agent: finished on the state edge, from the screen", async () => {
  const w = world({ hasJournal: false });
  later(20, () => w.setState("working"));
  later(50, () => w.setState("idle"));
  const r = await w.call("send_message", { id: "w1:p1", text: "go", wait_seconds: 1 });
  expect(r.data).toEqual({ sent: true, cursor: TAG, status: "finished", reply: ["screen line"], source: "screen" });
});

test("the demo refusal surfaces as a tool error", async () => {
  const w = world({}, { sendReply: demoActions().sendReply });
  const r = await w.call("send_message", { id: "w1:p1", text: "go" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("demo");
});

test("each call logs one line without the text", async () => {
  const w = world();
  const lines: string[] = [];
  w.deps.log = (l) => lines.push(l);
  await w.call("send_message", { id: "w1:p1", text: "a secret plan" });
  expect(lines).toEqual(["mcp: send_message w1:p1 sent len=13"]);
});
