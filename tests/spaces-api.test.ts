import { expect, test } from "bun:test";
import { fetchSpaceTree } from "@web/api";
import type { Fetch } from "@web/api";

const TREE = { spaces: [], readAt: 1 };

test("a 200 resolves with the tree", async () => {
  const f: Fetch = async () => new Response(JSON.stringify(TREE), { status: 200 });
  expect(await fetchSpaceTree(f)).toEqual(TREE);
});

test("a 404 rejects with the server's detail rather than resolving empty", async () => {
  const f: Fetch = async () =>
    new Response(JSON.stringify({ ok: false, detail: "herdr is not connected; no tree to read" }), { status: 404 });
  await expect(fetchSpaceTree(f)).rejects.toThrow("herdr is not connected");
});

test("it is a GET and sends no body", async () => {
  let seen: RequestInit | undefined;
  const f: Fetch = async (_p, init) => { seen = init; return new Response(JSON.stringify(TREE)); };
  await fetchSpaceTree(f);
  expect(seen?.method ?? "GET").toBe("GET");
  expect(seen?.body).toBeUndefined();
});
