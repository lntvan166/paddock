import { expect, test } from "bun:test";
import {
  historyFor, prunePanes, rememberHistory, rememberScreen, screenFor, cacheSize,
} from "@web/pane-cache";

function seed(ids: string[]) {
  for (const id of ids) {
    rememberScreen(id, { lines: [`${id} screen`], digest: id });
    rememberHistory(id, { settled: [`${id} history`], gaps: 0 });
  }
}

test("an agent that disappears loses both of its caches", () => {
  prunePanes(new Set());
  seed(["w1:p1", "w1:p2", "w1:p3"]);

  prunePanes(new Set(["w1:p1", "w1:p3"]));

  expect(screenFor("w1:p2")).toBeUndefined();
  expect(historyFor("w1:p2")).toBeUndefined();
  // The survivors are untouched — pruning must not be a clear().
  expect(screenFor("w1:p1")?.digest).toBe("w1:p1");
  expect(historyFor("w1:p3")?.settled).toEqual(["w1:p3 history"]);
});

test("pruning to nothing empties both caches", () => {
  prunePanes(new Set());
  seed(["a", "b"]);
  prunePanes(new Set());
  expect(cacheSize()).toEqual({ screens: 0, histories: 0 });
});

test("pruning is idempotent", () => {
  prunePanes(new Set());
  seed(["a", "b"]);
  prunePanes(new Set(["a"]));
  const once = cacheSize();
  prunePanes(new Set(["a"]));
  expect(cacheSize()).toEqual(once);
});

test("an agent still present keeps its history across a prune", () => {
  // The reason this matters: pruning runs whenever the agent list changes,
  // which is often. An over-eager prune would silently discard the scrollback
  // the operator is reading.
  prunePanes(new Set());
  seed(["keep"]);
  for (let i = 0; i < 5; i++) prunePanes(new Set(["keep"]));
  expect(historyFor("keep")?.settled).toEqual(["keep history"]);
});

test("caches only ever hold agents that were seeded", () => {
  prunePanes(new Set());
  seed(["a"]);
  // A live id with no cache entry must not create one.
  prunePanes(new Set(["a", "never-opened"]));
  expect(cacheSize()).toEqual({ screens: 1, histories: 1 });
});
