import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent, AgentCommand } from "@shared/types";

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "blocked", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project", harness: "claude",
    stateSince: NOW, stateSinceExact: true, updatedAt: NOW,
    acknowledgedAt: null, hasJournal: false, ...over,
  };
}

/** Records the cwd it was asked about — the thing under test. */
function harness(a: Agent = agent(), commands: AgentCommand[] = []) {
  const store = new AgentStore("dev-box");
  store.replaceAll([a], NOW);
  const asked: string[] = [];
  const app = createApp({
    store,
    hub: new Hub(),
    health: () => ({}) as never,
    readCommands: async (cwd: string) => {
      asked.push(cwd);
      return commands;
    },
  });
  return { app, asked };
}

const cmd = (command: string): AgentCommand => ({
  command,
  description: "does a thing",
  source: "command",
});

test("the commands of an agent's own project are served", async () => {
  const { app, asked } = harness(agent(), [cmd("/check"), cmd("/eod")]);

  const res = await app.request("/api/agents/w1:p1/commands", { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    commands: [cmd("/check"), cmd("/eod")],
  });
  // The DECISION under test: the directory came from the agent's own record,
  // not from anything the browser sent.
  expect(asked).toEqual(["/srv/project"]);
});

test("an unknown agent is a 404, and nothing is read", async () => {
  const { app, asked } = harness();

  const res = await app.request("/api/agents/nope/commands", { method: "POST" });

  expect(res.status).toBe(404);
  expect(asked, "no filesystem call for an agent that does not exist").toEqual([]);
});

test("an agent with no cwd is served an empty list, not a read of the root", async () => {
  // `toAgent` defaults a missing herdr `cwd` to "", so this is reachable. The
  // hazard is real: joining "" with ".claude/commands" resolves relative to
  // paddock's OWN process directory, which has nothing to do with the agent.
  const { app, asked } = harness(agent({ cwd: "" }), [cmd("/wrong")]);

  const res = await app.request("/api/agents/w1:p1/commands", { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, commands: [] });
  expect(asked, "an empty cwd must never reach the reader").toEqual([]);
});

test("a reader that throws is an empty list, not a broken reply field", async () => {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app = createApp({
    store,
    hub: new Hub(),
    health: () => ({}) as never,
    readCommands: async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    },
  });

  const res = await app.request("/api/agents/w1:p1/commands", { method: "POST" });

  // The autocomplete is a convenience on top of a field that must keep
  // working. A 500 here would be a red error in the UI for a feature the
  // operator did not ask for.
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, commands: [] });
});

test("with no reader configured the route still answers, emptily", async () => {
  // `--demo` omits it, the same way it omits `actions` and `journal`.
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app = createApp({ store, hub: new Hub(), health: () => ({}) as never });

  const res = await app.request("/api/agents/w1:p1/commands", { method: "POST" });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, commands: [] });
});
