import { expect, test } from "bun:test";
import { createFileStore, FILE_ID_RE } from "@server/files/store";

/**
 * The map exists for one reason: `CLAUDE.md` forbids payloads in GET URLs,
 * because they land in edge access logs — and a file path is exactly such a
 * payload. An `<iframe src>` and a download link both need a plain GET, so the
 * path is POSTed once and a meaningless id travels in the URL after that.
 */

test("a path is exchanged for an id, and comes back", () => {
  const store = createFileStore();
  const id = store.issue("/srv/project/design.html");
  expect(store.resolve(id)).toBe("/srv/project/design.html");
});

test("the id reveals nothing about the path", () => {
  const store = createFileStore();
  const id = store.issue("/srv/somewhere/private/design.html");

  expect(id).toMatch(FILE_ID_RE);
  expect(id).not.toContain("private");
  expect(id).not.toContain("design");
});

test("an unknown id resolves to nothing rather than throwing", () => {
  expect(createFileStore().resolve("nope")).toBeNull();
});

test("the same path issued twice returns the same id", () => {
  // Tapping one link repeatedly must not grow the map without bound.
  const store = createFileStore();
  expect(store.issue("/srv/project/a.html")).toBe(store.issue("/srv/project/a.html"));
});

test("the map is capped, and evicts the oldest", () => {
  const store = createFileStore({ cap: 2 });
  const first = store.issue("/srv/project/1.html");
  const second = store.issue("/srv/project/2.html");
  const third = store.issue("/srv/project/3.html");

  expect(store.resolve(first), "the oldest is gone").toBeNull();
  expect(store.resolve(second)).toBe("/srv/project/2.html");
  expect(store.resolve(third)).toBe("/srv/project/3.html");
});

test("an evicted path can be issued again, with a fresh id", () => {
  // The reverse index has to be cleaned on eviction too. Left behind, it would
  // hand back an id whose entry no longer resolves — a link that silently 404s
  // for the rest of the process's life.
  const store = createFileStore({ cap: 1 });
  const first = store.issue("/srv/project/1.html");
  store.issue("/srv/project/2.html");

  const again = store.issue("/srv/project/1.html");

  expect(again).not.toBe(first);
  expect(store.resolve(again)).toBe("/srv/project/1.html");
});
