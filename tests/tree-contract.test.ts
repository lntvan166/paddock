import { expect, test } from "bun:test";
import type { SpaceTree, TreePane } from "@shared/types";

// These are TYPE-level assertions with a runtime shell. The real gate is
// `make check` (tsc --noEmit): the annotations below are what fail if the
// contract drifts — `state: null` stops compiling the moment `TreePane.state`
// loses its null, and no `expect` here could catch that. The runtime bodies
// exist so the file is a test rather than a fixture, and so the intent is
// stated in prose beside them; do not read them as the coverage.

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
