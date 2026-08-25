import { expect, test } from "bun:test";
import type { SpaceTree, TreePane } from "@shared/types";

test("a shell pane carries a null state, not idle", () => {
  const shell: TreePane = {
    paneId: "w1:p2", harness: null, name: null,
    title: "bash", cwd: "/srv/project", state: null,
  };
  // The whole point: a shell is not idle. Nothing may coerce this to a state.
  expect(shell.state).toBeNull();
  expect(shell.harness).toBeNull();
});

test("a tree records when it was read", () => {
  const tree: SpaceTree = { spaces: [], readAt: 1_700_000_000_000 };
  expect(tree.readAt).toBeGreaterThan(0);
});
