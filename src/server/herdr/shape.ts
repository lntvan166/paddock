import { HERDR_PROTOCOL } from "@shared/herdr-api";

/**
 * The fields paddock reads whose absence is UNAMBIGUOUS evidence that herdr's
 * contract moved.
 *
 * Required in `HerdrAgentRaw`, so herdr sends them on every entry — an absent
 * one cannot be explained by an unconfigured pane, only by a protocol change.
 *
 * Deliberately NOT here: `name` and `terminal_title_stripped`. Both are `?:` in
 * `HerdrAgentRaw` and `adapter.ts` already falls back for both (`name` to
 * `pane_id`, the task line to `terminal_title` and then to empty), so a pane
 * that was simply never named legitimately lacks them. Checking them would
 * report a protocol break on an ordinary install, and a check that cries wolf
 * on normal data is worse than no check — it trains you to ignore it.
 *
 * This list is the honest expression of what paddock depends on. If
 * `adapter.ts` starts reading a new REQUIRED field, add it here; that is the
 * whole maintenance burden.
 */
export const REQUIRED_AGENT_FIELDS = ["pane_id", "workspace_id", "agent_status"] as const;

export type ShapeVerdict =
  /** Nothing to inspect — no panes open. Not a verdict about the contract. */
  | { kind: "unknown" }
  | { kind: "ok" }
  | { kind: "broken"; missing: string[] };

/**
 * Verify herdr's real `agent.list` response against what paddock reads.
 *
 * This exists because a protocol NUMBER was never the contract. `checkProtocol`
 * now accepts a newer herdr, since herdr bumps often and mostly additively —
 * and this is the safety that trades for: what actually breaks the dashboard is
 * a field going away, and only live data can show that.
 *
 * Checked on live data rather than against `herdr api schema --json`, and that
 * is deliberate: `doctor.ts` records that the CLI answers from the binary on
 * disk while the socket answers from the running daemon, and the two disagree
 * after an upgrade — which is the exact confusion this work exists to end.
 *
 * EVERY entry is inspected, not element 0. herdr builds each one separately, so
 * a field can survive on one pane and vanish on another.
 */
export function checkAgentShape(agents: readonly unknown[]): ShapeVerdict {
  if (agents.length === 0) return { kind: "unknown" };

  const missing = new Set<string>();
  for (const agent of agents) {
    if (typeof agent !== "object" || agent === null) {
      // Not an object at all: nothing paddock reads can be there. Reported as
      // every field missing rather than skipped, because skipping it would let
      // a wholesale response-shape change read as "ok".
      for (const field of REQUIRED_AGENT_FIELDS) missing.add(field);
      continue;
    }
    const record = agent as Record<string, unknown>;
    for (const field of REQUIRED_AGENT_FIELDS) {
      // `null` counts as missing: it renders every agent in one wrong state
      // just as surely as an absent key, and it is the shape a renamed field
      // leaves behind.
      if (record[field] === undefined || record[field] === null) missing.add(field);
    }
  }

  if (missing.size === 0) return { kind: "ok" };
  return { kind: "broken", missing: [...missing].sort() };
}

/**
 * The same finding as one line, for `/api/health`.
 *
 * Separate from `shapeMessage` because the audiences differ: that one is a
 * console block with a remedy, this one lands in JSON a phone renders in a
 * banner, where embedded newlines become a run-on blob.
 */
export function shapeSummary(verdict: ShapeVerdict): string | null {
  if (verdict.kind !== "broken") return null;
  return `herdr's agent.list is missing ${verdict.missing.join(", ")} — paddock reads ${verdict.missing.length === 1 ? "it" : "them"}`;
}

/**
 * What to tell the operator, or null when there is nothing to say.
 *
 * Names the fields rather than saying "incompatible", because the field name is
 * the only part that tells you where to look.
 */
export function shapeMessage(verdict: ShapeVerdict, herdrProtocol: number): string | null {
  if (verdict.kind !== "broken") return null;
  return [
    "paddock: herdr's agent.list is missing fields paddock reads",
    `  missing           ${verdict.missing.join(", ")}`,
    `  herdr protocol    ${herdrProtocol}`,
    `  paddock built for ${HERDR_PROTOCOL}`,
    "",
    "  A field paddock reads has moved or gone. Regenerate the contract, then",
    "  re-check the one file that maps it:",
    "    make types",
    "    src/server/herdr/adapter.ts",
  ].join("\n");
}
