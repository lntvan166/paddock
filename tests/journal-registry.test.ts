import { expect, test } from "bun:test";
import { adapterFor, hasAdapter } from "@server/journal/registry";

const claude = { agent: "claude", kind: "id", source: "herdr:claude", value: "u1" };

test("a claude session resolves to the claude adapter", () => {
  expect(adapterFor(claude)?.name).toBe("claude");
  expect(hasAdapter(claude)).toBe(true);
});

test("a harness with no adapter is an ordinary no, not an error", () => {
  // The route reports this as `source: "reconstruction"`, so an unknown
  // harness must be a null rather than a throw.
  expect(adapterFor({ ...claude, agent: "some-other-harness" })).toBeNull();
  expect(hasAdapter({ ...claude, agent: "some-other-harness" })).toBe(false);
});

test("a session that is not an id is refused", () => {
  // `kind` can name something that is not a session identifier. Only "id" is
  // a value this code knows how to turn into a path.
  expect(hasAdapter({ ...claude, kind: "path" })).toBe(false);
});

test("no session at all is false, never a throw", () => {
  expect(hasAdapter(null)).toBe(false);
  expect(hasAdapter(undefined)).toBe(false);
});
