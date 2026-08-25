import { expect, test } from "bun:test";
import { resolveSource } from "@server/herdr/actions";

test("a shell always gets scrollback: it is on the normal screen and costs ~2ms", () => {
  expect(resolveSource(null, false)).toBe("recent_unwrapped");
  expect(resolveSource(null, true)).toBe("recent_unwrapped");
});

test("the agent rules are unchanged", () => {
  expect(resolveSource("idle", true)).toBe("recent_unwrapped");
  expect(resolveSource("idle", false)).toBe("visible");
  expect(resolveSource("working", true)).toBe("visible");
  expect(resolveSource("blocked", false)).toBe("visible");
});
