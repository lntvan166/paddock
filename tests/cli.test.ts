import { expect, test } from "bun:test";
import { parseArgs } from "@server/cli";

test("bare invocation serves — the Docker CMD and every doc depend on it", () => {
  expect(parseArgs([])).toEqual({ command: "serve", flags: new Set() });
});

test("--demo still serves", () => {
  expect(parseArgs(["--demo"])).toEqual({ command: "serve", flags: new Set(["--demo"]) });
});

test("update is a command, and carries its own flag", () => {
  expect(parseArgs(["update"])).toEqual({ command: "update", flags: new Set() });
  expect(parseArgs(["update", "--check"]))
    .toEqual({ command: "update", flags: new Set(["--check"]) });
});

test("flags may precede the command", () => {
  expect(parseArgs(["--check", "update"]))
    .toEqual({ command: "update", flags: new Set(["--check"]) });
});
