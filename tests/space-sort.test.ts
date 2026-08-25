import { expect, test } from "bun:test";
import { sortSpaces, spaceState } from "@web/components/space-sort";
import type { Space } from "@shared/types";

function space(spaceId: string, states: (Space["tabs"][number]["panes"][number]["state"])[]): Space {
  const panes = states.map((state, i) => ({
    paneId: `${spaceId}:p${i}`, harness: state === null ? null : "claude",
    name: null, title: null, cwd: "/srv/project", state,
  }));
  return {
    spaceId, label: spaceId, tabCount: 1, paneCount: panes.length,
    tabs: [{ tabId: `${spaceId}:t1`, label: null, panes }],
  };
}

test("the rollup is the worst state any pane is in", () => {
  expect(spaceState(space("w1", ["idle", "blocked", "working"]))).toBe("blocked");
  expect(spaceState(space("w2", ["idle", "working"]))).toBe("working");
  expect(spaceState(space("w3", ["idle", "done"]))).toBe("done");
  expect(spaceState(space("w4", ["idle", "idle"]))).toBe("idle");
});

test("a space whose every pane is a shell has NO state, not idle", () => {
  // A shell is not idle. Inventing a state for it would sort it among spaces
  // that have an agent doing nothing, which is a different thing.
  expect(spaceState(space("w5", [null, null]))).toBeNull();
});

test("one agent among shells still decides the rollup", () => {
  expect(spaceState(space("w6", [null, "blocked", null]))).toBe("blocked");
});

test("blocked first, working next, then everything else, then no agent", () => {
  const order = sortSpaces([
    space("idle", ["idle"]),
    space("none", [null]),
    space("blocked", ["blocked"]),
    space("done", ["done"]),
    space("working", ["working"]),
  ]).map((s) => s.spaceId);
  expect(order.slice(0, 2)).toEqual(["blocked", "working"]);
  expect(order[4]).toBe("none");
  expect(order.slice(2, 4).sort()).toEqual(["done", "idle"]);
});

test("done and idle share a bucket, so herdr's own order survives between them", () => {
  // Not a detail: re-reading the tree must not reshuffle rows the operator is
  // looking at. Array.prototype.sort is stable, and these two ranking equal is
  // what makes that stability visible.
  const a = sortSpaces([space("d", ["done"]), space("i", ["idle"])]).map((s) => s.spaceId);
  const b = sortSpaces([space("i", ["idle"]), space("d", ["done"])]).map((s) => s.spaceId);
  expect(a).toEqual(["d", "i"]);
  expect(b).toEqual(["i", "d"]);
});

test("sorting does not mutate the array it was given", () => {
  const input = [space("b", ["idle"]), space("a", ["blocked"])];
  const before = input.map((s) => s.spaceId);
  sortSpaces(input);
  expect(input.map((s) => s.spaceId)).toEqual(before);
});
