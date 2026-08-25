import { expect, test } from "bun:test";
import { expandHome, toSpaceTree } from "@server/herdr/tree";
import type { HerdrSessionSnapshot } from "@shared/herdr-api";
import snapshot from "./fixtures/session-snapshot.json";

const NOW = 1_700_000_000_000;
const tree = () => toSpaceTree(snapshot as unknown as HerdrSessionSnapshot, NOW);

test("every space in the snapshot reaches the tree", () => {
  expect(tree().spaces.map((s) => s.spaceId)).toEqual(["w1", "w2", "w3"]);
});

test("a pane with no agent survives, with a null harness and a null state", () => {
  const shell = tree().spaces.find((s) => s.spaceId === "w3")!.tabs[0]!.panes[0]!;
  expect(shell.paneId).toBe("w3:p1");
  expect(shell.harness).toBeNull();
  expect(shell.state).toBeNull();
  expect(shell.name).toBeNull();
  // Its only label is the terminal title.
  expect(shell.title).toBe("bash");
});

test("an agent pane carries agent.list's name, never the pane's title", () => {
  const pane = tree().spaces.find((s) => s.spaceId === "w1")!.tabs[0]!.panes[0]!;
  expect(pane.name).toBe("api-refactor");
  expect(pane.harness).toBe("claude");
  expect(pane.state).toBe("working");
});

test("an unnamed tab reports a null label, not its number as a string", () => {
  const t = tree().spaces.find((s) => s.spaceId === "w1")!.tabs[0]!;
  expect(t.label).toBeNull();
});

test("a named tab keeps its label", () => {
  const t = tree().spaces.find((s) => s.spaceId === "w2")!.tabs.find((x) => x.tabId === "w2:t1")!;
  expect(t.label).toBe("migrate-up");
});

test("counts come from herdr rather than being recomputed", () => {
  const w2 = tree().spaces.find((s) => s.spaceId === "w2")!;
  expect(w2.tabCount).toBe(2);
  expect(w2.paneCount).toBe(2);
});

test("readAt is the clock passed in, so the UI can say how stale it is", () => {
  expect(tree().readAt).toBe(NOW);
});

test("a home-directory cwd is tilde-ised, so no username crosses the wire", () => {
  const snap = { ...(snapshot as any), panes: (snapshot as any).panes.map((p: any) =>
    p.pane_id === "w3:p1" ? { ...p, cwd: "/base/operator/work" } : p) };
  const t = toSpaceTree(snap as HerdrSessionSnapshot, NOW, { home: "/base/operator" });
  const pane = t.spaces.find((s) => s.spaceId === "w3")!.tabs[0]!.panes[0]!;
  expect(pane.cwd).toBe("~/work");
  expect(pane.cwd).not.toContain("operator");
});

test("a cwd outside home is untouched", () => {
  const t = toSpaceTree(snapshot as unknown as HerdrSessionSnapshot, NOW, { home: "/base/operator" });
  const pane = t.spaces.find((s) => s.spaceId === "w1")!.tabs[0]!.panes[0]!;
  expect(pane.cwd).toBe("/srv/project");
});

test("a pane whose tab is missing from the snapshot is dropped, not orphaned", () => {
  const broken = {
    ...(snapshot as any),
    panes: [...(snapshot as any).panes, { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1", agent_status: "idle", cwd: "/srv/project", focused: false, revision: 1 }],
  };
  const spaces = toSpaceTree(broken as HerdrSessionSnapshot, NOW).spaces;
  expect(spaces.map((s) => s.spaceId)).not.toContain("w9");
});

test("expandHome is the exact inverse of the tilde-ising the tree does", () => {
  // The tilde only exists because paddock put it there, and it comes back:
  // the create sheet offers the tree's own cwds as quick picks. Measured live,
  // herdr neither expands nor refuses one — the pane came up in the home
  // directory with nothing saying the chosen folder was ignored.
  const home = "/base/operator";
  expect(expandHome("~/work", home)).toBe("/base/operator/work");
  expect(expandHome("~", home)).toBe("/base/operator");
  // A trailing slash on HOME must not double up.
  expect(expandHome("~/work", "/base/operator/")).toBe("/base/operator/work");
  // Round trip, through the real tilde-ising: whatever the tree renders is
  // what a quick pick sends back, so this has to arrive as what herdr said.
  const snap = { ...(snapshot as any), panes: (snapshot as any).panes.map((p: any) =>
    p.pane_id === "w3:p1" ? { ...p, cwd: "/base/operator/work" } : p) };
  const t = toSpaceTree(snap as HerdrSessionSnapshot, NOW, { home });
  const rendered = t.spaces.find((s) => s.spaceId === "w3")!.tabs[0]!.panes[0]!.cwd;
  expect(rendered).toBe("~/work");
  expect(expandHome(rendered, home)).toBe("/base/operator/work");
});

test("expandHome leaves alone everything that is not paddock's own tilde", () => {
  const home = "/base/operator";
  expect(expandHome("/srv/project", home)).toBe("/srv/project");
  // Another user's home. paddock knows ONE home directory; guessing the
  // layout of the others would be inventing a path.
  expect(expandHome("~someone/work", home)).toBe("~someone/work");
  // A relative path that merely starts with a tilde character is not `~/`.
  expect(expandHome("~work", home)).toBe("~work");
  // No home, and the degenerate `/` home, both leave the value untouched —
  // the same cases `tildeise` declines to act on.
  expect(expandHome("~/work", undefined)).toBe("~/work");
  expect(expandHome("~/work", "/")).toBe("~/work");
  expect(expandHome("", home)).toBe("");
});
