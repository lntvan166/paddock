import { expect, test } from "bun:test";
import { BackendUnavailable, Unsupported } from "@server/action-errors";
import { actionsByOrigin } from "@server/actions-by-origin";
import type { HerdrActions } from "@server/herdr/actions";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent } from "@shared/types";

/**
 * The composite that sends each action to the backend that owns the id.
 * A core id (`hc.…`) must never reach terminal herdr, and a herdr id must
 * never reach the core: either would type into the wrong terminal.
 */

const NOW = 1_700_000_000_000;

/** A backend that records `<tag>:<method>:<first arg>` for every call. */
function recorder(tag: string, log: string[]): HerdrActions {
  const rec = (name: string) => async (...args: unknown[]) => {
    log.push(`${tag}:${name}:${typeof args[0] === "string" ? args[0] : JSON.stringify(args[0])}`);
    if (name === "readOutput" || name === "readPane") return { lines: [], source: "visible" };
    if (name === "readPromptScreen") return "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
    if (name === "promptAllowed") return tag === "herdr";
    if (name === "createSpace") return { spaceId: "s", tabId: "t", paneId: "p" };
    if (name === "createTab") return { tabId: "t", paneId: "p" };
    if (name === "harnessKinds") return tag === "herdr" ? ["claude", "codex"] : ["claude", "reviewer"];
    return undefined;
  };
  return new Proxy({}, { get: (_t, name) => rec(String(name)) }) as unknown as HerdrActions;
}

/** Every method that takes an id first, with a call that passes `id`. */
const BY_ID: [string, (a: HerdrActions, id: string) => Promise<unknown>][] = [
  ["readOutput", (a, id) => a.readOutput(id, "idle")],
  ["readPane", (a, id) => a.readPane(id)],
  ["readPromptScreen", (a, id) => a.readPromptScreen(id)],
  ["sendOptionKey", (a, id) => a.sendOptionKey(id, "1")],
  ["sendNavKey", (a, id) => a.sendNavKey(id, "up")],
  ["sendChars", (a, id) => a.sendChars(id, ["a"])],
  ["sendReply", (a, id) => a.sendReply(id, "hi")],
  ["sendPaneText", (a, id) => a.sendPaneText(id, "ls")],
  ["sendPaneKey", (a, id) => a.sendPaneKey(id, "up")],
  ["waitUntilUnblocked", (a, id) => a.waitUntilUnblocked(id)],
  ["renameAgent", (a, id) => a.renameAgent(id, "x")],
  ["renameTab", (a, id) => a.renameTab(id, "x")],
  ["renameSpace", (a, id) => a.renameSpace(id, "x")],
  ["closeTab", (a, id) => a.closeTab(id)],
  ["closeSpace", (a, id) => a.closeSpace(id)],
  ["createTab", (a, id) => a.createTab(id, {})],
  ["startAgent", (a, id) => a.startAgent(id, "claude", "api-refactor")],
  ["markSeen", (a, id) => a.markSeen(id, 3)],
  ["promptAllowed", (a, id) => a.promptAllowed(id)],
];

test("actionsByOrigin sends hc. ids to core and others to herdr", async () => {
  for (const [name, call] of BY_ID) {
    const log: string[] = [];
    const a = actionsByOrigin(recorder("herdr", log), recorder("core", log));
    await call(a, "hc.t7");
    await call(a, "w1:p1");
    expect(log, name).toEqual([`core:${name}:hc.t7`, `herdr:${name}:w1:p1`]);
  }
});

test("the dispatch list covers the whole interface", () => {
  const a = actionsByOrigin(recorder("herdr", []), recorder("core", []));
  const NO_ID = ["createSpace", "harnessKinds"];
  expect(Object.keys(a).sort()).toEqual([...BY_ID.map(([n]) => n), ...NO_ID].sort());
});

test("createSpace goes to herdr unless the core is asked for", async () => {
  const log: string[] = [];
  const a = actionsByOrigin(recorder("herdr", log), recorder("core", log));
  await a.createSpace({});
  await a.createSpace({ origin: "core" });
  expect(log.map((l) => l.split(":")[0])).toEqual(["herdr", "core"]);
});

test("harness kinds are both backends' kinds, herdr's first", async () => {
  const a = actionsByOrigin(recorder("herdr", []), recorder("core", []));
  expect(await a.harnessKinds()).toEqual(["claude", "codex", "reviewer"]);
});

test("a core that is not running costs herdr's harness kinds nothing", async () => {
  const core = { ...recorder("core", []), harnessKinds: async () => { throw new BackendUnavailable("herdr-core is not running"); } };
  const a = actionsByOrigin(recorder("herdr", []), core as HerdrActions);
  expect(await a.harnessKinds()).toEqual(["claude", "codex"]);
});

test("a missing backend is a typed refusal naming it", async () => {
  const onlyHerdr = actionsByOrigin(recorder("herdr", []), undefined);
  const e1 = await onlyHerdr.sendOptionKey("hc.t7", "1").catch((e) => e);
  expect(e1).toBeInstanceOf(BackendUnavailable);
  expect(e1.message).toBe("herdr-core is not running");
  const onlyCore = actionsByOrigin(undefined, recorder("core", []));
  const e2 = await onlyCore.sendOptionKey("w1:p1", "1").catch((e) => e);
  expect(e2).toBeInstanceOf(BackendUnavailable);
  expect(e2.message).toBe("terminal herdr is not running");
});

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "hc.t7", name: "api-refactor", task: "Extract auth middleware",
    state: "blocked", workspaceId: "hc.spA", workspaceLabel: null, cwd: "/srv/project", harness: "claude",
    stateSince: NOW, stateSinceExact: true, updatedAt: NOW, acknowledgedAt: null, hasJournal: false,
    origin: "core", turn: 1, seen: 0, ...over,
  };
}

function route(actions: HerdrActions, a: Agent = agent()) {
  const store = new AgentStore("dev-box");
  store.replaceAll([a], NOW, a.origin);
  const app = createApp({
    store, hub: new Hub({ now: () => NOW }), actions, now: () => NOW,
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, core: { connected: false, lastEventAt: null, generation: null, version: null, detail: null }, app: null, schemaWarning: null }),
  });
  return (path: string, body: object) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("a missing backend is a 503 with its name", async () => {
  const post = route(actionsByOrigin(recorder("herdr", []), undefined));
  const res = await post("/api/agents/hc.t7/answer", { key: "1" });
  expect(res.status).toBe(503);
  expect((await res.json()).detail).toBe("herdr-core is not running");

  const out = await post("/api/agents/hc.t7/output", {});
  expect(out.status).toBe(503);
});

test("an unsupported action is a 409 carrying its reason verbatim", async () => {
  const core = { ...recorder("core", []), renameAgent: async () => { throw new Unsupported("herdr can't rename a running app terminal"); } };
  const post = route(actionsByOrigin(recorder("herdr", []), core as HerdrActions), agent({ state: "idle" }));
  const res = await post("/api/agents/hc.t7/name", { name: "x" });
  expect(res.status).toBe(409);
  expect((await res.json()).detail).toBe("herdr can't rename a running app terminal");
});

test("any other failure is still a 502", async () => {
  const core = { ...recorder("core", []), sendOptionKey: async () => { throw new Error("t7 is gone"); } };
  const post = route(actionsByOrigin(recorder("herdr", []), core as HerdrActions));
  const res = await post("/api/agents/hc.t7/answer", { key: "1" });
  expect(res.status).toBe(502);
  expect((await res.json()).detail).toBe("t7 is gone");
});

const PERMISSION = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";

/** A core backend whose live terminal reports `kind` (undefined: none). */
function coreWithKind(kind: string | undefined) {
  return {
    ...recorder("core", []),
    readPromptScreen: async () => PERMISSION,
    promptAllowed: async () => kind === "permission",
  } as HerdrActions;
}

test("/prompt offers one-tap options for a core agent only on a permission prompt", async () => {
  for (const kind of ["question", "auth", undefined]) {
    const post = route(actionsByOrigin(recorder("herdr", []), coreWithKind(kind)));
    const body = await (await post("/api/agents/hc.t7/prompt", {})).json();
    expect(body.options, String(kind)).toBeNull();
    expect(body.dialog, String(kind)).toBeNull();
  }
  const post = route(actionsByOrigin(recorder("herdr", []), coreWithKind("permission")));
  const body = await (await post("/api/agents/hc.t7/prompt", {})).json();
  expect(body.options.map((o: { key: string }) => o.key)).toEqual(["1", "2"]);
});

test("/prompt for a herdr agent is unchanged", async () => {
  // Terminal herdr's real answer: the parser alone decides.
  const herdr = { readPromptScreen: async () => PERMISSION, promptAllowed: async () => true };
  const post = route(actionsByOrigin(herdr as unknown as HerdrActions, coreWithKind(undefined)), agent({ agentId: "w1:p1", origin: "herdr", workspaceId: "w1" }));
  const body = await (await post("/api/agents/w1:p1/prompt", {})).json();
  expect(body.options.map((o: { key: string }) => o.key)).toEqual(["1", "2"]);
});
