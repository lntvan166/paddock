import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Unsupported } from "@server/action-errors";
import { inScope, isRemoteTerminal } from "@server/herdr-core/adapter";
import { createCoreActions, NOT_ON_THIS_MACHINE } from "@server/herdr-core/actions";
import type { AppSocket } from "@server/herdr-core/app-socket";
import { CoreSupervisor, type CoreClientLike } from "@server/herdr-core/supervisor";
import { readCoreSpaces } from "@server/herdr-core/tree";
import { SettingsStore } from "@server/settings/store";
import { AgentStore, type Delta } from "@server/state/store";
import type { CoreEvent, CoreSubscribeResult, CoreTerminal, CoreUnknownEvent } from "@shared/herdr-core-api";
import type { MachineScope } from "@shared/types";

/*
 * `agents.machines`: the Herdr app can add another machine over SSH, and
 * herdr-core then lists that machine's terminals beside this one's, addressed
 * `machine/t7`. Under `local` they must not reach the store (and so not the
 * Agents screen, push, or the MCP tools), the Spaces screen, or any action.
 *
 * Invented names only: `build-box` is the added machine.
 */

const term = (address: string, over: Partial<CoreTerminal> = {}): CoreTerminal => ({
  address, argv: [], cols: 80, rows: 24, created_ms: 1, cwd: "/path/to/proj",
  labels: { "herdr.space": "spA", "herdr.tab": "tbA", where: "api / 1" },
  screen: "exact", state: "live", name: `agent-${address.replace("/", "-")}`, title: "", turn: 1,
  status: { state: "idle", app: "claude-code" }, status_ms: 5, ...over,
});

/** One list as herdr-core gives it: this machine's terminals, then build-box's. */
const MIXED = [term("t1"), term("t2"), term("build-box/t1"), term("build-box/t9")];

class FakeClient implements CoreClientLike {
  onSnapshot!: (s: CoreSubscribeResult) => void;
  onEvent!: (e: CoreEvent | CoreUnknownEvent) => void;
  hello = async () => ({ core: { id: "c", name: "c" }, features: [], framed: false, generation: 1, methods: [] }) as never;
  request = async () => ({ version: "9.9.9" }) as never;
  subscribe = async (a: any, b: any) => { this.onSnapshot = a; this.onEvent = b; return () => {}; };
  close = () => {};
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function running(scope: { v: MachineScope }) {
  const c = new FakeClient();
  const store = new AgentStore("dev-box");
  const deltas: Delta[] = [];
  const sup = new CoreSupervisor({ connect: () => c, store, onDelta: (d) => deltas.push(d), scope: () => scope.v });
  sup.start();
  await tick();
  c.onSnapshot({ channel: null, seq: 1, terminals: MIXED });
  return { c, store, deltas, sup };
}
const ids = (s: AgentStore) => s.snapshot().map((a) => a.agentId).sort();

test("a terminal is remote by herdr-core's own machine address, never by its folder", () => {
  expect(isRemoteTerminal("t7")).toBe(false);
  expect(isRemoteTerminal("build-box/t7")).toBe(true);
  // An event names the machine even if a caller only has the bare address.
  expect(isRemoteTerminal("t7", "build-box")).toBe(true);
  expect(isRemoteTerminal("t7", null)).toBe(false);
  expect(inScope("all", "build-box/t7")).toBe(true);
  expect(inScope("local", "build-box/t7")).toBe(false);
  expect(inScope("local", "t7")).toBe(true);
});

test("`all` lists every machine's agents, as before the setting existed", async () => {
  const { store, sup } = await running({ v: "all" });
  expect(ids(store)).toEqual(["hc.build-box/t1", "hc.build-box/t9", "hc.t1", "hc.t2"]);
  // Another machine's agent names its machine, for the mark; this one's none.
  const by = (id: string) => store.snapshot().find((x) => x.agentId === id)!;
  expect(by("hc.build-box/t1").machine).toBe("build-box");
  expect(by("hc.t1").machine).toBeNull();
  sup.stop();
});

test("`local` keeps another machine's agents out of the store, which is all MCP's list_agents reads", async () => {
  const { store, sup } = await running({ v: "local" });
  expect(ids(store)).toEqual(["hc.t1", "hc.t2"]);
  sup.stop();
});

test("under `local`, another machine's events never create or change an agent", async () => {
  const { c, store, deltas, sup } = await running({ v: "local" });
  deltas.length = 0;
  c.onEvent({ seq: 2, terminal: "build-box/t5", machine: "build-box", type: "created", data: term("build-box/t5") } as never);
  c.onEvent({ seq: 3, terminal: "build-box/t1", machine: "build-box", type: "status",
    data: { status: { state: "blocked", app: "claude-code", kind: "permission" }, records: {}, reported: true } } as never);
  expect(ids(store)).toEqual(["hc.t1", "hc.t2"]);
  // Nothing published, so nothing reaches push or Telegram either.
  expect(deltas).toEqual([]);
  // This machine's events still apply.
  c.onEvent({ seq: 4, terminal: "t1", type: "status",
    data: { status: { state: "blocked", app: "claude-code" }, records: {}, reported: true } } as never);
  expect(store.snapshot().find((a) => a.agentId === "hc.t1")!.state).toBe("blocked");
  sup.stop();
});

test("changing the scope applies without reconnecting, and a hidden agent comes back current", async () => {
  const scope = { v: "local" as MachineScope };
  const { c, store, sup } = await running(scope);
  // While hidden, build-box/t1 goes blocked on a later turn.
  c.onEvent({ seq: 2, terminal: "build-box/t1", machine: "build-box", type: "turn", data: { turn: 4, state: "working" } } as never);
  c.onEvent({ seq: 3, terminal: "build-box/t1", machine: "build-box", type: "status",
    data: { status: { state: "blocked", app: "claude-code" }, records: {}, reported: true } } as never);

  scope.v = "all";
  sup.rescope();
  expect(ids(store)).toEqual(["hc.build-box/t1", "hc.build-box/t9", "hc.t1", "hc.t2"]);
  const back = store.snapshot().find((a) => a.agentId === "hc.build-box/t1")!;
  expect(back.state).toBe("blocked");
  expect(back.turn).toBe(4);

  scope.v = "local";
  sup.rescope();
  expect(ids(store)).toEqual(["hc.t1", "hc.t2"]);
  sup.stop();
});

test("the Spaces screen leaves another machine's terminals out under `local`", async () => {
  const client = {
    async request<T>(method: string): Promise<T> {
      if (method === "terminal.list") {
        return { hidden_finished: 0, machines: [], terminals: [
          term("t1"),
          term("build-box/t1", { labels: { "herdr.space": "spRemote", "herdr.tab": "tbR", where: "remote / 1" } }),
        ] } as T;
      }
      throw new Error("not_found");
    },
  };
  expect((await readCoreSpaces(client, "/base/operator", "all"))?.map((s) => s.spaceId).sort()).toEqual(["hc.spA", "hc.spRemote"]);
  expect((await readCoreSpaces(client, "/base/operator", "local"))?.map((s) => s.spaceId)).toEqual(["hc.spA"]);
});

test("under `local`, no action reaches a terminal on another machine, even by a typed id", async () => {
  const calls: string[] = [];
  const scope = { v: "local" as MachineScope };
  const client = {
    async request<T>(method: string, params: any = {}): Promise<T> {
      calls.push(`${method} ${params.terminal ?? ""}`);
      if (method === "terminal.read") return { text: "hello", complete: true, how: "screen" } as T;
      if (method === "terminal.list") {
        return { hidden_finished: 0, machines: [], terminals: [
          term("t1", { labels: { "herdr.space": "spA" } }),
          term("build-box/t1", { labels: { "herdr.space": "spA" } }),
        ] } as T;
      }
      return {} as T;
    },
  };
  const app: AppSocket = { async available() { return false; }, async renameSpace() {}, async renameTab() {} };
  const a = createCoreActions(() => client as never, app, { sleep: async () => {}, scope: () => scope.v });

  await expect(a.sendReply("hc.build-box/t1", "hi")).rejects.toThrow(new Unsupported(NOT_ON_THIS_MACHINE));
  await expect(a.readPane("hc.build-box/t1")).rejects.toBeInstanceOf(Unsupported);
  expect(calls).toEqual([]);

  // A whole-space close kills only this machine's terminal in that space.
  await a.closeSpace("hc.spA");
  expect(calls.filter((c) => c.startsWith("terminal.kill"))).toEqual(["terminal.kill t1"]);

  // Under `all` the same id is reachable.
  scope.v = "all";
  calls.length = 0;
  await a.sendReply("hc.build-box/t1", "hi");
  expect(calls).toContain("terminal.send build-box/t1");
});

const dir = async () => mkdtemp(join(tmpdir(), "paddock-machines-"));

test("the setting defaults to `all`, is stored, and tells its listeners", async () => {
  const d = await dir();
  const s = new SettingsStore(d, {});
  await s.load();
  expect(s.machines()).toBe("all");
  expect(s.view().agents).toEqual({ machines: "all", envOverride: null });
  let told = 0;
  s.onChange(() => { told++; });
  await s.patch({ agents: { machines: "local" } });
  expect(told).toBe(1);
  expect(s.machines()).toBe("local");
  expect(JSON.parse(await readFile(join(d, "settings.json"), "utf8")).agents).toEqual({ machines: "local" });
});

test("PADDOCK_MACHINES wins over the stored value; an invalid one is ignored", async () => {
  const d = await dir();
  await writeFile(join(d, "settings.json"), JSON.stringify({ version: 2, agents: { machines: "all" } }));
  const s = new SettingsStore(d, { PADDOCK_MACHINES: "local" });
  await s.load();
  expect(s.machines()).toBe("local");
  expect(s.view().agents).toEqual({ machines: "local", envOverride: "local" });

  const bad = new SettingsStore(d, { PADDOCK_MACHINES: "build-box" });
  await bad.load();
  expect(bad.machines()).toBe("all");
  expect(bad.view().agents.envOverride).toBeNull();
});

test("a hand-edited agents.machines that is not a scope is reset, and said", async () => {
  const d = await dir();
  await writeFile(join(d, "settings.json"), JSON.stringify({ version: 2, agents: { machines: "remote" } }));
  const lines: string[] = [];
  const orig = console.info;
  console.info = (m: string) => { lines.push(m); };
  try {
    const s = new SettingsStore(d, {});
    await s.load();
    expect(s.machines()).toBe("all");
  } finally {
    console.info = orig;
  }
  expect(lines.some((l) => l.includes("agents.machines"))).toBe(true);
});
