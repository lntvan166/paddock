import { expect, test } from "bun:test";
import { BackendUnavailable, Unsupported } from "@server/action-errors";
import { OPEN_HERDR_TO_RENAME, type AppSocket } from "@server/herdr-core/app-socket";
import { NAV_TO_CORE, createCoreActions } from "@server/herdr-core/actions";
import { CoreError } from "@server/herdr-core/socket";
import { CTRL_LETTERS, NAV_KEYS } from "@shared/types";

/**
 * herdr-core actions, against a FAKE core. Nothing here talks to a real core
 * or app: the operator's own terminals must never be touched by a test.
 *
 * The answer path is the one that matters most. The probe
 * (docs/probes/2026-11-09-herdr-core.md, steps 3 and 4) measured that a
 * blocked prompt is answered by `terminal.keys` with ONE digit, and that
 * `terminal.send {force:true}` approves the command whatever it pastes — a
 * "No" sent that way is a "Yes". So these tests assert the exact method and
 * params, and that `force` never appears in any call.
 */

type Call = { method: string; params: any };

function fakeCore(answer: (method: string, params: any) => unknown = () => ({})) {
  const calls: Call[] = [];
  const client = {
    async request<T>(method: string, params: object = {}): Promise<T> {
      calls.push({ method, params });
      const r = answer(method, params);
      if (r instanceof Error) throw r;
      return r as T;
    },
  };
  return { calls, client };
}

function fakeApp(up: boolean) {
  const renames: string[] = [];
  const app: AppSocket = {
    async available() { return up; },
    async renameSpace(id, name) { renames.push(`space:${id}:${name}`); },
    async renameTab(id, name) { renames.push(`tab:${id}:${name}`); },
  };
  return { app, renames };
}

function actions(answer?: (method: string, params: any) => unknown, appUp = false) {
  const core = fakeCore(answer);
  const app = fakeApp(appUp);
  const a = createCoreActions(() => core.client, app.app, { sleep: async () => {} });
  return { a, calls: core.calls, renames: app.renames };
}

const terminal = (over: Record<string, unknown> = {}) => ({
  address: "t7", argv: ["claude"], cols: 200, rows: 120, created_ms: 1, cwd: "/srv/project",
  labels: { "herdr.space": "spA", "herdr.tab": "tbA" }, screen: "exact", state: "live",
  status: { state: "idle", app: "claude-code" }, ...over,
});

function noForceAnywhere(calls: Call[]) {
  for (const c of calls) expect(JSON.stringify(c.params)).not.toContain("force");
}

test("core keys use the core key names", async () => {
  const { a, calls } = actions(() => ({ turn: 1 }));
  await a.sendNavKey("hc.t7", "up");
  await a.sendNavKey("hc.t7", "enter");
  await a.sendNavKey("hc.t7", "esc");
  await a.sendNavKey("hc.t7", "ctrl-c");
  await a.sendPaneKey("hc.t9", "ctrl-d");
  expect(calls).toEqual([
    { method: "terminal.keys", params: { terminal: "t7", keys: ["up"] } },
    { method: "terminal.keys", params: { terminal: "t7", keys: ["enter"] } },
    { method: "terminal.keys", params: { terminal: "t7", keys: ["esc"] } },
    { method: "terminal.keys", params: { terminal: "t7", keys: ["ctrl+c"] } },
    { method: "terminal.keys", params: { terminal: "t9", keys: ["ctrl+d"] } },
  ]);
});

test("the key table covers every key the terminal view can send", () => {
  const every = [...NAV_KEYS, ...CTRL_LETTERS.map((l) => `ctrl-${l}`)];
  expect(Object.keys(NAV_TO_CORE).sort()).toEqual([...every].sort());
  for (const l of CTRL_LETTERS) expect(NAV_TO_CORE[`ctrl-${l}`]).toBe(`ctrl+${l}`);
});

const permission = { state: "blocked", kind: "permission", app: "claude-code" };

test("answer uses the measured call", async () => {
  const { a, calls } = actions((m) => (m === "terminal.get" ? terminal({ status: permission }) : { status: "blocked", turn: 1 }));
  // The digit is whatever the route passes — the parsed option's own key.
  // Claude Code's "No" is 4 in manual mode and 3 elsewhere; never a constant.
  await a.sendOptionKey("hc.t7", "4");
  expect(calls).toEqual([
    { method: "terminal.get", params: { terminal: "t7" } },
    { method: "terminal.keys", params: { terminal: "t7", keys: ["4"] } },
  ]);
  noForceAnywhere(calls);
});

test("an option key that is not one digit is refused before anything is sent", async () => {
  const { a, calls } = actions(() => ({ turn: 1 }));
  for (const bad of ["", "0", "10", "12", "y", "enter"]) {
    await expect(a.sendOptionKey("hc.t7", bad)).rejects.toBeInstanceOf(Unsupported);
  }
  expect(calls).toEqual([]);
});

test("a reply to a blocked core agent is refused, and nothing is typed", async () => {
  const { a, calls } = actions((m) => (m === "terminal.get" ? terminal({ status: { state: "blocked", kind: "permission" } }) : {}));
  const err = await a.sendReply("hc.t7", "yes").catch((e) => e);
  expect(err).toBeInstanceOf(Unsupported);
  expect(err.message).toContain("answer the dialog's options");
  expect(calls.map((c) => c.method)).toEqual(["terminal.get"]);
});

test("a reply to a core agent that is not blocked is sent without force", async () => {
  const { a, calls } = actions((m) => (m === "terminal.get" ? terminal() : { turn: 2, started: true }));
  await a.sendReply("hc.t7", "run the suite");
  expect(calls).toEqual([
    { method: "terminal.get", params: { terminal: "t7" } },
    { method: "terminal.send", params: { terminal: "t7", text: "run the suite" } },
  ]);
  noForceAnywhere(calls);
});

test("typing into an app agent's dialog is refused outright, and nothing is sent", async () => {
  // Not only while blocked: `terminal.send` presses Enter, so in the race
  // where the store says blocked and the terminal no longer is, the dialog
  // text would be submitted to the agent as a prompt.
  for (const state of ["blocked", "idle", "working"]) {
    const { a, calls } = actions(() => terminal({ status: { state, kind: "question" } }));
    const err = await a.sendChars("hc.t7", ["o", "k"]).catch((e) => e);
    expect(err).toBeInstanceOf(Unsupported);
    expect(err.message).toContain("answer in Herdr");
    expect(calls).toEqual([]);
  }
});

test("reads drop the trailing CR and report an empty screen as no lines", async () => {
  const { a, calls } = actions((_m, p) => ({ text: p.terminal === "t7" ? "one\r\ntwo\r\n" : "", complete: true, how: "screen" }));
  const live = await a.readOutput("hc.t7", "working");
  expect(live).toEqual({ lines: ["one", "two", ""], source: "visible" });
  expect((await a.readOutput("hc.t8", "idle")).lines).toEqual([]);
  const hist = await a.readOutput("hc.t7", "idle", undefined, true);
  expect(hist.source).toBe("recent_unwrapped");
  expect(await a.readPromptScreen("hc.t7")).toBe("one\r\ntwo\r\n");
  // `lines` is history ABOVE the screen: zero for the live read, the history
  // budget for scrollback.
  expect(calls.map((c) => c.params.lines)).toEqual([0, 0, 400, 0]);
  expect(calls.every((c) => c.method === "terminal.read")).toBe(true);
});

test("closing a core tab kills only its labelled terminals", async () => {
  const { a, calls } = actions((m, p) => {
    if (m === "terminal.list") {
      return {
        hidden_finished: 0, machines: [],
        terminals: [
          terminal({ address: "t1", labels: { "herdr.space": "spA", "herdr.tab": "tbA" } }),
          terminal({ address: "t2", labels: { "herdr.space": "spA", "herdr.tab": "tbA" } }),
          // A core that ignored the filter must not cost the operator this one.
          terminal({ address: "t3", labels: { "herdr.space": "spA", "herdr.tab": "tbB" } }),
          terminal({ address: "t4", labels: { "herdr.space": "spA", "herdr.tab": "tbA" }, state: "finished" }),
        ],
      };
    }
    return terminal({ address: p.terminal });
  });
  await a.closeTab("hc.tbA");
  expect(calls).toEqual([
    { method: "terminal.list", params: { labels: { "herdr.tab": "tbA" } } },
    { method: "terminal.kill", params: { terminal: "t1" } },
    { method: "terminal.kill", params: { terminal: "t2" } },
  ]);
});

test("closing a core space kills every terminal in it", async () => {
  const { a, calls } = actions((m) => (m === "terminal.list"
    ? { hidden_finished: 0, machines: [], terminals: [terminal({ address: "t1" }), terminal({ address: "t2", labels: { "herdr.space": "spA", "herdr.tab": "tbB" } })] }
    : {}));
  await a.closeSpace("hc.spA");
  expect(calls.map((c) => `${c.method}:${c.params.terminal ?? JSON.stringify(c.params.labels)}`)).toEqual([
    `terminal.list:{"herdr.space":"spA"}`, "terminal.kill:t1", "terminal.kill:t2",
  ]);
});

test("closing a core tab with no live terminal says so instead of reporting success", async () => {
  const { a } = actions(() => ({ hidden_finished: 0, machines: [], terminals: [] }));
  await expect(a.closeTab("hc.tbGone")).rejects.toThrow(/no live terminal/);
});

test("creating a space without the app starts a terminal with a fresh space label and seen=0", async () => {
  const { a, calls, renames } = actions((m) => (m === "terminal.run" ? terminal({ address: "t12" }) : {}));
  const out = await a.createSpace({ cwd: "/srv/project" as never });
  expect(calls.length).toBe(1);
  const run = calls[0]!;
  expect(run.method).toBe("terminal.run");
  const { labels, ...rest } = run.params;
  expect(rest).toEqual({ cwd: "/srv/project", keep: true });
  expect(labels["herdr.space"]).toMatch(/^sp[0-9a-f]{32}$/);
  expect(labels["herdr.tab"]).toMatch(/^tb[0-9a-f]{32}$/);
  expect(labels["herdr.seen"]).toBe("0");
  expect(out).toEqual({ spaceId: `hc.${labels["herdr.space"]}`, tabId: `hc.${labels["herdr.tab"]}`, paneId: "hc.t12" });
  expect(renames).toEqual([]);
  // Fresh every time: two spaces never share an id.
  await a.createSpace({});
  expect(calls[1]!.params.labels["herdr.space"]).not.toBe(labels["herdr.space"]);
});

test("a named space with the app closed is refused before anything is created", async () => {
  const { a, calls } = actions(() => terminal());
  const err = await a.createSpace({ label: "api work" }).catch((e) => e);
  expect(err).toBeInstanceOf(Unsupported);
  expect(err.message).toBe(OPEN_HERDR_TO_RENAME);
  const tab = await a.createTab("hc.spA", { label: "tests" }).catch((e) => e);
  expect(tab).toBeInstanceOf(Unsupported);
  expect(calls).toEqual([]);
});

test("a named space with the app running is created through the core, then named by the app", async () => {
  const { a, calls, renames } = actions((m) => (m === "terminal.run" ? terminal({ address: "t12" }) : {}), true);
  const out = await a.createSpace({ label: "api work" });
  const raw = calls[0]!.params.labels["herdr.space"];
  expect(renames).toEqual([`space:${raw}:api work`]);
  expect(out.spaceId).toBe(`hc.${raw}`);
});

test("creating a tab joins the space's label and folder", async () => {
  const { a, calls, renames } = actions((m) => {
    if (m === "terminal.list") return { hidden_finished: 0, machines: [], terminals: [terminal({ address: "t1", cwd: "/srv/project" })] };
    if (m === "terminal.run") return terminal({ address: "t13" });
    return {};
  }, true);
  const out = await a.createTab("hc.spA", { label: "tests" });
  const run = calls.find((c) => c.method === "terminal.run")!;
  expect(run.params.labels["herdr.space"]).toBe("spA");
  expect(run.params.labels["herdr.tab"]).toMatch(/^tb[0-9a-f]{32}$/);
  expect(run.params.labels["herdr.seen"]).toBe("0");
  expect(run.params.cwd).toBe("/srv/project");
  expect(run.params.keep).toBe(true);
  expect(out).toEqual({ tabId: `hc.${run.params.labels["herdr.tab"]}`, paneId: "hc.t13" });
  expect(renames).toEqual([`tab:${run.params.labels["herdr.tab"]}:tests`]);
});

test("starting an agent runs it in the pane's space and tab", async () => {
  const { a, calls } = actions((m) => (m === "terminal.get" ? terminal({ address: "t9", cwd: "/srv/project" }) : terminal({ address: "t14" })));
  await a.startAgent("hc.t9", "claude", "api-refactor", ["--model", "x"]);
  expect(calls[1]).toEqual({
    method: "terminal.run",
    params: {
      argv: ["claude", "--model", "x"], name: "api-refactor", cwd: "/srv/project", keep: true,
      labels: { "herdr.space": "spA", "herdr.tab": "tbA", "herdr.seen": "0" },
    },
  });
});

test("renaming a core agent is refused with a reason", async () => {
  const { a, calls } = actions();
  const err = await a.renameAgent("hc.t7", "x").catch((e) => e);
  expect(err).toBeInstanceOf(Unsupported);
  expect(err.message).toBe("herdr can't rename a running app terminal");
  expect(calls).toEqual([]);
});

test("space and tab renames go to the app with the core id", async () => {
  const { a, renames } = actions(undefined, true);
  await a.renameSpace("hc.spA", "api work");
  await a.renameTab("hc.tbA", "tests");
  expect(renames).toEqual(["space:hc.spA:api work", "tab:hc.tbA:tests"]);
});

test("markSeen writes herdr.seen as the turn", async () => {
  const { a, calls } = actions(() => terminal());
  await a.markSeen("hc.t7", 5);
  expect(calls).toEqual([{ method: "terminal.label", params: { terminal: "t7", labels: { "herdr.seen": "5" } } }]);
});

test("waiting for an answer to land polls until the agent leaves blocked", async () => {
  const states = ["blocked", "blocked", "working"];
  const { a, calls } = actions(() => terminal({ status: { state: states.shift() ?? "working" } }));
  await a.waitUntilUnblocked("hc.t7");
  expect(calls.map((c) => c.method)).toEqual(["terminal.get", "terminal.get", "terminal.get"]);
});

test("waiting gives up with a reason when the agent stays blocked", async () => {
  let t = 0;
  const core = fakeCore(() => terminal({ status: { state: "blocked" } }));
  const a = createCoreActions(() => core.client, fakeApp(false).app, {
    sleep: async (ms) => { t += ms; }, now: () => t,
  });
  await expect(a.waitUntilUnblocked("hc.t7", 1_000)).rejects.toThrow(/still blocked/);
});

test("harness kinds are the core's usable templates", async () => {
  const { a } = actions(() => ({
    templates: [
      { name: "claude", description: "", command: "claude" },
      { name: "broken", description: "", command: "x", error: "bad file" },
    ],
  }));
  expect(await a.harnessKinds()).toEqual(["claude"]);
});

test("an option digit is pressed only on a live permission prompt", async () => {
  const cases: Record<string, unknown>[] = [
    { state: "blocked", kind: "question" },
    { state: "blocked", kind: "auth" },
    { state: "blocked" },
    { state: "idle", kind: "permission" },
  ];
  for (const status of cases) {
    const { a, calls } = actions((m) => (m === "terminal.get" ? terminal({ status }) : { turn: 1 }));
    await expect(a.sendOptionKey("hc.t7", "1"), JSON.stringify(status)).rejects.toBeInstanceOf(Unsupported);
    expect(calls.map((c) => c.method)).toEqual(["terminal.get"]);
  }
});

test("promptAllowed is true only for a blocked permission prompt", async () => {
  const at = async (status: unknown) => actions(() => terminal({ status })).a.promptAllowed("hc.t7");
  expect(await at(permission)).toBe(true);
  expect(await at({ state: "blocked", kind: "question" })).toBe(false);
  expect(await at({ state: "blocked", kind: "auth" })).toBe(false);
  expect(await at({ state: "blocked" })).toBe(false);
  expect(await at(null)).toBe(false);
});

test("a core error reaches the caller unchanged", async () => {
  const { a } = actions(() => new CoreError("t7 is gone", "not_found"));
  await expect(a.sendOptionKey("hc.t7", "1")).rejects.toThrow("t7 is gone");
});

test("a herdr id never reaches the core", async () => {
  const { a, calls } = actions();
  await expect(a.sendOptionKey("w1:p1", "1")).rejects.toThrow(/not a core id/);
  expect(calls).toEqual([]);
});

test("no core connection is a typed refusal", async () => {
  const a = createCoreActions(() => { throw new BackendUnavailable("herdr-core is not running"); }, fakeApp(false).app);
  await expect(a.sendOptionKey("hc.t7", "1")).rejects.toBeInstanceOf(BackendUnavailable);
});

test("typing into an app shell leaves the command on the line", async () => {
  // The pane route presses Enter itself, and only when asked to run it.
  const { a, calls } = actions(() => ({ turn: 0 }));
  await a.sendPaneText("hc.t9", "ls -la");
  expect(calls).toEqual([{ method: "terminal.keys", params: { terminal: "t9", keys: ["l", "s", "space", "-", "l", "a"] } }]);
});

// Step 6 of the probe: `A` as a key name types `a`, `shift+a` types `A`, and
// `+`, `|`, `_`, `:`, `~` and the rest have no key at all (invalid_params).
test("typing into an app shell sends an uppercase letter as shift plus the letter", async () => {
  const { a, calls } = actions(() => ({ turn: 0 }));
  await a.sendPaneText("hc.t9", "cd Src/x.y; a=1 [b] `c` 'd',\\");
  expect(calls[0]!.params.keys).toEqual([
    "c", "d", "space", "shift+s", "r", "c", "/", "x", ".", "y", ";", "space",
    "a", "=", "1", "space", "[", "b", "]", "space", "`", "c", "`", "space", "'", "d", "'", ",", "\\",
  ]);
});

test("a character with no measured key is refused and nothing is typed", async () => {
  for (const text of ["ls | wc", "a+b", "echo ~", "x_y", "a:b", "ls\n", "café"]) {
    const { a, calls } = actions(() => ({ turn: 0 }));
    const err = await a.sendPaneText("hc.t9", text).catch((e) => e);
    expect(err).toBeInstanceOf(Unsupported);
    expect(err.message).toContain("can't be typed into an app terminal");
    expect(calls).toEqual([]);
  }
});

test("a new app space with a harness runs the agent as its only terminal", async () => {
  const { a, calls } = actions((m) => (m === "terminal.run" ? terminal({ address: "t21" }) : {}));
  const out = await a.createSpace({ cwd: "/srv/project" as never, harness: { kind: "claude", name: "api-refactor" } });
  expect(calls.map((c) => c.method)).toEqual(["terminal.run"]);
  expect(calls[0]!.params.argv).toEqual(["claude"]);
  expect(calls[0]!.params.name).toBe("api-refactor");
  expect(out.paneId).toBe("hc.t21");
});

test("a new app tab with a harness runs the agent as its only terminal", async () => {
  const { a, calls } = actions((m) => {
    if (m === "terminal.list") return { hidden_finished: 0, machines: [], terminals: [terminal({ address: "t1" })] };
    if (m === "terminal.run") return terminal({ address: "t22" });
    return {};
  });
  const out = await a.createTab("hc.spA", { harness: { kind: "codex", name: "flaky-test-fix" } });
  const runs = calls.filter((c) => c.method === "terminal.run");
  expect(runs.length).toBe(1);
  expect(runs[0]!.params.argv).toEqual(["codex"]);
  expect(runs[0]!.params.name).toBe("flaky-test-fix");
  expect(out.paneId).toBe("hc.t22");
});

// ---------------------------------------------------------------------------
// Colour. `terminal.read` is text only; the screen is read as an observer's
// first paint instead, at the terminal's own size, and replayed. A failure
// there falls back to the text read, said in the log, never a blank screen.
// ---------------------------------------------------------------------------

function paintingCore(paint: () => Uint8Array | Error, answer: (m: string, p: any) => unknown) {
  const core = fakeCore(answer);
  const observed: any[] = [];
  const client = {
    ...core.client,
    async observePaint(t: string, cols: number, rows: number, history: number) {
      observed.push({ t, cols, rows, history });
      const r = paint();
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const a = createCoreActions(() => client, fakeApp(false).app, { sleep: async () => {} });
  return { a, observed, calls: core.calls };
}

test("an app agent's screen keeps its colours, read at the terminal's own size", async () => {
  const { a, observed } = paintingCore(
    () => new TextEncoder().encode("\x1b[38;5;1mred\x1b[0m plain"),
    (m) => (m === "terminal.get" ? terminal({ cols: 90, rows: 30 }) : { text: "red plain" }),
  );
  const out = await a.readOutput("hc.t7", "idle", 0);
  expect(observed).toEqual([{ t: "t7", cols: 90, rows: 30, history: 0 }]);
  expect(out.lines[0]).toContain("\x1b[");
  expect(out.lines[0]).toContain("red");
  expect(out.source).toBe("visible");
});

test("scrollback asks the paint for history", async () => {
  const { a, observed } = paintingCore(
    () => new TextEncoder().encode("x"),
    (m) => (m === "terminal.get" ? terminal() : { text: "x" }),
  );
  await a.readOutput("hc.t7", "idle", 0, true);
  expect(observed[0].history).toBeGreaterThan(0);
});

test("a paint that fails falls back to the text read and says so once", async () => {
  const infos: string[] = [];
  const orig = console.info;
  console.info = (...args: unknown[]) => { infos.push(args.join(" ")); };
  try {
    const { a } = paintingCore(
      () => new Error("no paint from t7 within 10000 ms"),
      (m) => (m === "terminal.get" ? terminal() : { text: "plain text\n" }),
    );
    expect((await a.readOutput("hc.t7", "idle", 0)).lines[0]).toBe("plain text");
    await a.readOutput("hc.t7", "idle", 0);
    expect(infos.filter((l) => l.includes("no paint from t7"))).toHaveLength(1);
  } finally {
    console.info = orig;
  }
});

test("the prompt parsers still get the plain text read, not the paint", async () => {
  const { a, observed } = paintingCore(
    () => new TextEncoder().encode("\x1b[1mDo you want to proceed?"),
    (m) => (m === "terminal.get" ? terminal() : { text: "Do you want to proceed?\n" }),
  );
  expect(await a.readPromptScreen("hc.t7")).toBe("Do you want to proceed?\n");
  expect(observed).toHaveLength(0);
});
