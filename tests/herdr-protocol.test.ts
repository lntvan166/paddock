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

/**
 * The pin must never be AHEAD of the installed herdr — it may lag.
 *
 * This used to assert equality, and equality is no longer the property. herdr
 * bumps its protocol often and mostly additively (0.8.0 → 0.8.2 moved 19 → 20
 * and changed nothing paddock reads), `checkProtocol` now accepts a newer
 * herdr, and the fields paddock actually depends on are verified against live
 * `agent.list` data by `src/server/herdr/shape.ts`. So a lagging pin is a
 * legitimate state, and failing on it was the drift detector crying wolf: it
 * went red for a version integer with no consequence, which teaches everyone to
 * ignore a red build.
 *
 * A pin AHEAD of the installed herdr is a real defect, and the one this still
 * catches: the committed types would describe a herdr that is not there, which
 * is exactly the direction `checkProtocol` still refuses at runtime and
 * `scripts/protocol-guard.ts` refuses to generate.
 */
test.skipIf(live === null)("the pinned protocol is not ahead of the installed herdr", () => {
  expect(HERDR_PROTOCOL).toBeLessThanOrEqual(live!);
});
