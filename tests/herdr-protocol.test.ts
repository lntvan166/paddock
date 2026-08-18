import { expect, test } from "bun:test";
import { HERDR_PROTOCOL } from "@shared/herdr-api";

/**
 * Compares paddock's pinned protocol against a LIVE herdr, so it can only run
 * where herdr is installed. Skipped with a stated reason elsewhere — a CI
 * runner has no herdr, and a suite that goes red for an environmental reason
 * teaches everyone to ignore a red build.
 *
 * Contrast `immutable-cache.test.ts`, which deliberately FAILS rather than
 * skips when `dist/` is missing: CI can build `dist/`, so skipping there would
 * hide a real gap on every run. Skip only what the environment cannot supply.
 */
async function liveProtocol(): Promise<number | null> {
  try {
    const proc = Bun.spawn(["herdr", "api", "schema", "--json"], {
      stdout: "pipe", stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0 || text.trim() === "") return null;
    return JSON.parse(text).protocol as number;
  } catch {
    return null;
  }
}

const live = await liveProtocol();
if (live === null) {
  console.info("herdr-protocol: herdr not installed — protocol pin not checked.");
}

test.skipIf(live === null)("pinned protocol matches the installed herdr schema", () => {
  expect(live).toBe(HERDR_PROTOCOL);
});
