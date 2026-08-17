import { expect, test } from "bun:test";
import { HERDR_PROTOCOL } from "@shared/herdr-api";

test("pinned protocol matches the installed herdr schema", async () => {
  const proc = Bun.spawn(["herdr", "api", "schema", "--json"], { stdout: "pipe" });
  const schema = JSON.parse(await new Response(proc.stdout).text());
  expect(schema.protocol).toBe(HERDR_PROTOCOL);
});
