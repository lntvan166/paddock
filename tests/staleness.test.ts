import { expect, test } from "bun:test";
import { staleAttrs } from "@web/components/staleness";

test("stale container carries data-stale when stale", () => {
  expect(staleAttrs(true)).toEqual({ "data-stale": "true" });
});

test("stale container carries no attribute when not stale", () => {
  expect(staleAttrs(false)).toEqual({});
});
