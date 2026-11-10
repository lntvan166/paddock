import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createSpacesReader } from "@server/spaces-read";
import { mergeTrees } from "@server/herdr-core/tree";
import type { Space, SpaceTree } from "@shared/types";

/**
 * The Spaces read over both backends. It used `Promise.all`, so a terminal
 * herdr that was not running took the app's spaces down with it — the Spaces
 * screen of an app-only paddock was a permanent error. Each side now fails on
 * its own: one backend down shows the other's spaces and says why once.
 */

const NOW = 1_700_000_000_000;

const herdrSpace: Space = {
  spaceId: "w1", label: "api refactor", origin: "herdr", tabCount: 1, paneCount: 1,
  tabs: [{ tabId: "w1:t1", label: null, panes: [] }],
};
const coreSpace: Space = {
  spaceId: "hc.docs-site", label: "docs-site", origin: "core", tabCount: 1, paneCount: 1,
  tabs: [{ tabId: "hc.tab-build", label: "build", panes: [] }],
};
const herdrTree: SpaceTree = { spaces: [herdrSpace], readAt: NOW - 5 };

let info: ReturnType<typeof spyOn>;
beforeEach(() => { info = spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { info.mockRestore(); });

const reader = (herdr: () => Promise<SpaceTree>, core: (() => Promise<Space[] | null>) | null) =>
  createSpacesReader({ herdr, core, merge: mergeTrees, now: () => NOW });

test("both answer: herdr's spaces first, then the app's", async () => {
  const tree = await reader(async () => herdrTree, async () => [coreSpace])();
  expect(tree.spaces.map((s) => s.spaceId)).toEqual(["w1", "hc.docs-site"]);
});

test("terminal herdr failing with app spaces present shows the app's spaces, said once", async () => {
  const read = reader(async () => { throw new Error("connect ENOENT"); }, async () => [coreSpace]);
  const first = await read();
  const second = await read();
  expect(first.spaces.map((s) => s.spaceId)).toEqual(["hc.docs-site"]);
  expect(first.readAt).toBe(NOW);
  expect(second.spaces).toHaveLength(1);
  const said = info.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes("ENOENT"));
  expect(said, "the reason is said once, not on every refresh").toHaveLength(1);
});

test("the app's read failing shows terminal herdr's tree, said once", async () => {
  // Including a throw from shaping the app's tree (toCoreSpaceTree), which
  // runs inside the core read and so takes the same path.
  const read = reader(async () => herdrTree, async () => { throw new Error("bad layout"); });
  expect(await read()).toEqual(herdrTree);
  expect(await read()).toEqual(herdrTree);
  const said = info.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes("bad layout"));
  expect(said).toHaveLength(1);
});

test("both failing is an error, as before", async () => {
  const read = reader(
    async () => { throw new Error("connect ENOENT"); },
    async () => { throw new Error("bad layout"); },
  );
  await expect(read()).rejects.toThrow("connect ENOENT");
});

test("terminal herdr failing with no app spaces is herdr's error, as before", async () => {
  await expect(reader(async () => { throw new Error("connect ENOENT"); }, async () => null)())
    .rejects.toThrow("connect ENOENT");
  await expect(reader(async () => { throw new Error("connect ENOENT"); }, null)())
    .rejects.toThrow("connect ENOENT");
});

test("no core connected reads exactly what terminal herdr gave", async () => {
  expect(await reader(async () => herdrTree, null)()).toEqual(herdrTree);
});
