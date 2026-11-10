import { expect, test } from "bun:test";
import type { CoreTerminal } from "@shared/herdr-core-api";
import type { Space, SpaceTree } from "@shared/types";
import { mergeTrees, readCoreSpaces, toCoreSpaceTree } from "@server/herdr-core/tree";

/*
 * The app's spaces, as the Spaces screen shows them. Invented names and
 * `/srv/...` / `/base/operator` paths only — the public repo rule.
 *
 * The layout document's shape is the one measured in
 * docs/probes/2026-11-09-herdr-core.md, step 5b.
 */

const HOME = "/base/operator";

function term(address: string, space: string | null, tab: string | null, over: Partial<CoreTerminal> = {}): CoreTerminal {
  const labels: Record<string, string> = {};
  if (space !== null) labels["herdr.space"] = space;
  if (tab !== null) labels["herdr.tab"] = tab;
  return {
    address, argv: ["sh"], cols: 200, rows: 120, created_ms: Number(address.slice(1)), cwd: "/srv/api",
    labels, screen: "exact", state: "live", status: null, ...over,
  };
}

const agent = (address: string, space: string, tab: string, over: Partial<CoreTerminal> = {}) =>
  term(address, space, tab, {
    argv: ["claude"], name: "api-refactor", title: "Claude Code",
    status: { state: "blocked", app: "claude-code", kind: "permission" } as CoreTerminal["status"],
    ...over,
  });

const LAYOUT = {
  spaces: [
    { id: "spB", name: "", folder: "/srv/docs", tabs: [
      { id: "tbB1", name: "", root: { id: "tbB1", type: "row", children: [
        { id: "p1", type: "block", content: { terminal: "t5" } },
      ] } },
    ] },
    { id: "spA", name: "api work", folder: "/srv/api", tabs: [
      { id: "tbA2", name: "tests", root: { id: "tbA2", type: "block", content: { terminal: "t3" } } },
      { id: "tbA1", name: "", root: { id: "tbA1", type: "row", children: [
        { id: "p2", type: "column", children: [
          { id: "p3", type: "block", content: { terminal: "t2" } },
          { id: "p4", type: "block", content: { terminal: "t1" } },
        ] },
      ] } },
    ] },
  ],
};

const TERMINALS = [
  agent("t1", "spA", "tbA1"),
  term("t2", "spA", "tbA1"),
  term("t3", "spA", "tbA2"),
  term("t5", "spB", "tbB1", { cwd: "/srv/docs" }),
];

test("terminals group by their space and tab labels", () => {
  const spaces = toCoreSpaceTree(TERMINALS, LAYOUT, HOME);
  // Order is the layout's: spaces, then tabs, then panes in the split tree.
  expect(spaces.map((s) => s.spaceId)).toEqual(["hc.spB", "hc.spA"]);
  const a = spaces[1]!;
  expect(a).toMatchObject({ label: "api work", origin: "core", tabCount: 2, paneCount: 3 });
  expect(a.tabs.map((t) => [t.tabId, t.label])).toEqual([["hc.tbA2", "tests"], ["hc.tbA1", null]]);
  expect(a.tabs[1]!.panes.map((p) => p.paneId)).toEqual(["hc.t2", "hc.t1"]);
  // A shell has no harness and no state; an agent has both.
  expect(a.tabs[1]!.panes[0]).toEqual({ paneId: "hc.t2", harness: null, name: null, title: null, cwd: "/srv/api", state: null });
  expect(a.tabs[1]!.panes[1]).toEqual({ paneId: "hc.t1", harness: "claude", name: "api-refactor", title: "Claude Code", cwd: "/srv/api", state: "blocked" });
  // An unnamed space is called after its folder.
  expect(spaces[0]!.label).toBe("docs");
});

test("an unreadable layout falls back to folder names and tab numbers", () => {
  for (const layout of [undefined, null, "x", { spaces: "no" }, { spaces: [{ id: 1 }] }, { other: [] }]) {
    const spaces = toCoreSpaceTree(TERMINALS, layout, HOME);
    // Nothing hidden: both spaces, every terminal.
    expect(spaces.map((s) => s.spaceId).sort()).toEqual(["hc.spA", "hc.spB"]);
    expect(spaces.reduce((n, s) => n + s.paneCount, 0)).toBe(4);
    const a = spaces.find((s) => s.spaceId === "hc.spA")!;
    expect(a.label).toBe("api");
    expect(a.tabs.map((t) => t.label)).toEqual([null, null]);
  }
});

test("a space in the home folder is called ~, and a terminal the layout lacks still shows", () => {
  const spaces = toCoreSpaceTree(
    [term("t8", "spH", "tbH", { cwd: HOME }), term("t9", "spA", "tbA1")],
    LAYOUT, HOME,
  );
  expect(spaces.map((s) => [s.spaceId, s.label])).toEqual([["hc.spA", "api work"], ["hc.spH", "~"]]);
  expect(spaces[1]!.tabs[0]!.panes[0]!.cwd).toBe("~");
  // t9 is in the layout's tab but not its split tree: listed, never dropped.
  expect(spaces[0]!.tabs.map((t) => t.panes.map((p) => p.paneId))).toEqual([["hc.t9"]]);
});

test("with no name in the layout, the app's own where label names the space", () => {
  const t = term("t6", "spW", "tbW", { cwd: "/srv/web" });
  t.labels["where"] = "web app / 1";
  expect(toCoreSpaceTree([t], undefined, HOME)[0]!.label).toBe("web app");
});

test("unlabelled terminals stay out", () => {
  const spaces = toCoreSpaceTree(
    [term("t1", null, null), term("t2", "spA", null), term("t3", null, "tbA1"), term("t4", "spA", "tbA1", { state: "finished" }), term("t5", "spA", "tbA1")],
    undefined, HOME,
  );
  expect(spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes.map((p) => p.paneId)))).toEqual(["hc.t5"]);
});

test("the merged tree lists terminal herdr's spaces first, then the app's", () => {
  const herdr: SpaceTree = {
    readAt: 5,
    spaces: [{ spaceId: "w1", label: "schema-migration", origin: "herdr", tabCount: 0, paneCount: 0, tabs: [] }],
  };
  const core: Space[] = [{ spaceId: "hc.spA", label: "api", origin: "core", tabCount: 0, paneCount: 0, tabs: [] }];
  expect(mergeTrees(herdr, core, 9).spaces.map((s) => s.spaceId)).toEqual(["w1", "hc.spA"]);
  expect(mergeTrees(herdr, core, 9).readAt).toBe(5);
  expect(mergeTrees(herdr, null, 9)).toEqual(herdr);
  expect(mergeTrees(null, core, 9)).toEqual({ spaces: core, readAt: 9 });
});

test("reading the app's spaces asks for the terminals and the layout document, and never writes it", async () => {
  const calls: string[] = [];
  const client = {
    async request<T>(method: string, params: object = {}): Promise<T> {
      calls.push(`${method} ${JSON.stringify(params)}`);
      if (method === "terminal.list") return { hidden_finished: 0, machines: [], terminals: TERMINALS } as T;
      if (method === "doc.get") return { version: 3, value: LAYOUT } as T;
      throw new Error(`unexpected ${method}`);
    },
  };
  const spaces = await readCoreSpaces(client, HOME);
  expect(spaces?.map((s) => s.spaceId)).toEqual(["hc.spB", "hc.spA"]);
  expect(calls.sort()).toEqual(['doc.get {"name":"herdr-app"}', "terminal.list {}"]);
});

test("a layout that cannot be read still shows the spaces, by fallback names", async () => {
  const client = {
    async request<T>(method: string): Promise<T> {
      if (method === "terminal.list") return { hidden_finished: 0, machines: [], terminals: TERMINALS } as T;
      throw new Error("not_found");
    },
  };
  const spaces = await readCoreSpaces(client, HOME);
  expect(spaces?.length).toBe(2);
});
