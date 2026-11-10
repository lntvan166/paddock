import { expect, test } from "bun:test";
import { BackendUnavailable, Unsupported } from "@server/action-errors";
import { actionsByOrigin, requireHerdr } from "@server/actions-by-origin";
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

test("app-only: a terminal herdr that is not running costs the core's harness kinds nothing", async () => {
  const herdr = { ...recorder("herdr", []), harnessKinds: async () => { throw new BackendUnavailable("terminal herdr is not running"); } };
  const a = actionsByOrigin(herdr as HerdrActions, recorder("core", []));
  expect(await a.harnessKinds()).toEqual(["claude", "reviewer"]);
});

test("app-only through the guard: harness kinds are the core's, said once at INFO", async () => {
  const infos: string[] = [];
  const orig = console.info;
  console.info = (...args: unknown[]) => { infos.push(args.join(" ")); };
  try {
    const a = actionsByOrigin(requireHerdr(recorder("herdr", []), () => false), recorder("core", []));
    expect(await a.harnessKinds()).toEqual(["claude", "reviewer"]);
    expect(await a.harnessKinds()).toEqual(["claude", "reviewer"]);
    expect(infos.filter((l) => l.includes("terminal herdr is not running"))).toHaveLength(1);
  } finally {
    console.info = orig;
  }
});

test("with neither backend up, harness kinds is terminal herdr's 503", async () => {
  const a = actionsByOrigin(requireHerdr(recorder("herdr", []), () => false), undefined);
  const e = await a.harnessKinds().catch((err) => err);
  expect(e).toBeInstanceOf(BackendUnavailable);
  expect(e.message).toBe("terminal herdr is not running");
});

test("requireHerdr refuses every call while terminal herdr is not connected, and passes through when it is", async () => {
  let up = false;
  const log: string[] = [];
  const g = requireHerdr(recorder("herdr", log), () => up);
  for (const [name, call] of BY_ID) {
    const e = await call(g, "w1:p1").catch((err: Error) => err) as Error;
    expect(e, name).toBeInstanceOf(BackendUnavailable);
    expect(e.message, name).toBe("terminal herdr is not running");
  }
  expect(log).toEqual([]);
  up = true;
  await g.sendOptionKey("w1:p1", "1");
  expect(log).toEqual(["herdr:sendOptionKey:w1:p1"]);
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

test("app-only: a herdr id is a 503 naming terminal herdr, not a 502", async () => {
  const herdrDown = requireHerdr(recorder("herdr", []), () => false);
  const post = route(actionsByOrigin(herdrDown, recorder("core", [])), agent({ agentId: "w1:p1", origin: "herdr", workspaceId: "w1" }));
  const res = await post("/api/agents/w1:p1/answer", { key: "1" });
  expect(res.status).toBe(503);
  expect((await res.json()).detail).toBe("terminal herdr is not running");
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
    promptAllowed: async () => kind === "permission" || kind === "question",
  } as HerdrActions;
}

test("/prompt offers one-tap options for a core agent only on a permission prompt or question", async () => {
  for (const kind of ["auth", undefined]) {
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

/**
 * A core backend whose screen parses as a dialog while its live status says
 * no (an auth prompt, or a dialog answered at the desk a moment ago), that
 * records every key it is asked to send. The dialog routes must ask the live
 * gate before moving a cursor or typing a character.
 */
function coreRefusedDialog(log: string[]) {
  const screen = [
    "Which deploy target should I use?",
    "",
    "❯ 1. Option number 1 with a reasonably long label",
    "  2. Option number 2 with a reasonably long label",
    "  3. Option number 3 with a reasonably long label",
    "",
    "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
  ].join("\n");
  return {
    ...recorder("core", log),
    readPromptScreen: async () => screen,
    readOutput: async () => ({ lines: screen.split("\n"), source: "visible" }),
    promptAllowed: async () => { log.push("core:promptAllowed"); return false; },
    sendNavKey: async (_t: string, k: string) => { log.push(`core:sendNavKey:${k}`); },
    sendOptionKey: async (_t: string, k: string) => { log.push(`core:sendOptionKey:${k}`); },
    sendChars: async (_t: string, c: string[]) => { log.push(`core:sendChars:${c.join("")}`); },
  } as unknown as HerdrActions;
}

const DIALOG_ROUTES: [string, object][] = [
  ["select", { key: "3" }],
  ["dialog-tab", { dir: "right" }],
  ["type", { text: "staging" }],
  ["note", { text: "staging", mode: "note-only" }],
  ["dialog-key", { key: "2" }],
];

for (const [path, body] of DIALOG_ROUTES) {
  test(`/${path} for a core agent is refused by the live gate, with nothing sent`, async () => {
    const log: string[] = [];
    const post = route(actionsByOrigin(recorder("herdr", []), coreRefusedDialog(log)));
    const res = await post(`/api/agents/hc.t7/${path}`, body);
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toContain("not showing a permission prompt or a question");
    expect(log).toEqual(["core:promptAllowed"]);
  });
}
