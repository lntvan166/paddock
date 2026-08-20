import { expect, test } from "bun:test";
import {
  historyFor, journalFor, prunePanes, rememberHistory, rememberScreen, screenFor,
  cacheSize, updateJournal,
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
  expect(cacheSize()).toEqual({ screens: 0, histories: 0, journals: 0 });
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
  expect(cacheSize()).toEqual({ screens: 1, histories: 1, journals: 0 });
});

test("journal history is held per agent, not per mount", () => {
  // The whole point of this module: `AgentTerminal` is remounted per agent and
  // on every navigation, so journal state living inside it was thrown away the
  // moment the operator went back to the list — six taps of history and six
  // POSTs, gone. The reconstructed path never lost its scrollback on that same
  // journey.
  prunePanes(new Set());
  updateJournal("a", (p) => ({ ...p, lines: ["older"], cursor: "120" }));
  updateJournal("a", (p) => ({ ...p, lines: ["oldest", ...p.lines], cursor: "60" }));
  expect(journalFor("a")).toEqual({
    lines: ["oldest", "older"], cursor: "60", done: false, fellBack: false,
  });
  // And it is per AGENT: one pane's pages never appear in another's.
  expect(journalFor("b")).toBeUndefined();
});

test("a pane that fell back stays fallen back", () => {
  // `fellBack` is the pane's permanent answer to "does this agent have a
  // readable journal". Losing it on navigation means re-asking the server on
  // every reopen, which decision 18 says happens once.
  prunePanes(new Set());
  updateJournal("a", (p) => ({ ...p, fellBack: true }));
  expect(journalFor("a")!.fellBack).toBe(true);
});

test("a closed pane's journal history does not linger", () => {
  // Evicted by the same signal as the screen and the scrollback: the agent is
  // gone. Otherwise this grows by one entry per agent ever opened.
  prunePanes(new Set());
  updateJournal("gone", (p) => ({ ...p, lines: ["x"] }));
  updateJournal("stays", (p) => ({ ...p, lines: ["y"] }));
  expect(cacheSize().journals).toBe(2);
  prunePanes(new Set(["stays"]));
  expect(journalFor("gone")).toBeUndefined();
  expect(journalFor("stays")).toBeDefined();
  expect(cacheSize().journals).toBe(1);
});
