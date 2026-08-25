import { expect, test } from "bun:test";
import { toSpaceTree } from "@server/herdr/tree";
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
