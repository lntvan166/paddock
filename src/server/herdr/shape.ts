import { HERDR_AGENT_STATUSES, HERDR_PROTOCOL } from "@shared/herdr-api";

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
  /**
   * `missing` — required fields absent from EVERY row.
   * `unknownStatuses` — `agent_status` values outside the generated enum.
   *
   * Both are reported together because both are the same failure: herdr's
   * contract moved in a way paddock cannot render. Either alone is enough to be
   * broken, so both arrays are always present and either may be empty.
   */
  | { kind: "broken"; missing: string[]; unknownStatuses: string[] };

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

  // Counted, not flagged. A field absent from ONE row is per-row variation —
  // `toAgent` already drops rows it cannot map, so `agent.list` demonstrably
  // carries entries paddock ignores, and `index.ts` exits 1 on `broken`. Only
  // absence from EVERY row distinguishes "herdr removed this" from "this pane
  // is different", and only that is worth taking the dashboard down for.
  const present = new Map<string, number>(REQUIRED_AGENT_FIELDS.map((f) => [f, 0]));
  const unknownStatuses = new Set<string>();
  let inspected = 0;

  for (const agent of agents) {
    // Skipped, not counted as every field missing. One malformed entry in a
    // large response is not evidence about the contract, and treating it as
    // such made a single bad row a hard startup refusal.
    if (typeof agent !== "object" || agent === null) continue;
    inspected += 1;

    const record = agent as Record<string, unknown>;
    for (const field of REQUIRED_AGENT_FIELDS) {
      // `null` is not presence: it renders every agent in one wrong state just
      // as surely as an absent key, and it is the shape a renamed field leaves.
      if (record[field] !== undefined && record[field] !== null) {
        present.set(field, present.get(field)! + 1);
      }
    }

    // The VALUE, not just the key. `checkProtocol` accepts any newer herdr, and
    // a status outside the generated enum makes `toState` return null, which
    // makes `toAgent` drop the row — every agent in a newly added state would
    // vanish from the dashboard with nothing logged. The generated union is the
    // contract, so a value outside it is unambiguous evidence it widened.
    const status = record.agent_status;
    if (typeof status === "string" && !(HERDR_AGENT_STATUSES as readonly string[]).includes(status)) {
      unknownStatuses.add(status);
    }
  }

  // Every row was unusable. That is not "the contract is fine", and it is not
  // evidence about any single field either.
  if (inspected === 0) return { kind: "broken", missing: [...REQUIRED_AGENT_FIELDS], unknownStatuses: [] };

  const missing = REQUIRED_AGENT_FIELDS.filter((f) => present.get(f) === 0);
  if (missing.length === 0 && unknownStatuses.size === 0) return { kind: "ok" };
  return { kind: "broken", missing: [...missing].sort(), unknownStatuses: [...unknownStatuses].sort() };
}

/**
 * The same finding as one line, for `/api/health`.
 *
 * Separate from `shapeMessage` because the audiences differ: that one is a
 * console block with a remedy, this one lands in a JSON field, where embedded
 * newlines become a run-on blob.
 *
 * Honest about its reach: nothing under `src/web/` reads it, and the UI never
 * fetches `/api/health` — so this is the operator's diagnostic surface (curl, a
 * monitor), exactly like `lastNotifyError` beside it, not something the phone
 * renders. Surfacing it in the dashboard would mean carrying it on the hub's
 * hello payload, which is its own change.
 */
export function shapeSummary(verdict: ShapeVerdict): string | null {
  if (verdict.kind !== "broken") return null;
  const parts: string[] = [];
  if (verdict.missing.length > 0) parts.push(`missing ${verdict.missing.join(", ")}`);
  if (verdict.unknownStatuses.length > 0) {
    parts.push(`unknown agent_status ${verdict.unknownStatuses.join(", ")}`);
  }
  return `herdr's agent.list does not match what paddock reads: ${parts.join("; ")}`;
}

/**
 * What to tell the operator, or null when there is nothing to say.
 *
 * Names the fields rather than saying "incompatible", because the field name is
 * the only part that tells you where to look.
 */
export function shapeMessage(verdict: ShapeVerdict, herdrProtocol: number): string | null {
  if (verdict.kind !== "broken") return null;
  const lines = [
    "paddock: herdr's agent.list does not match what paddock reads",
  ];
  if (verdict.missing.length > 0) lines.push(`  missing fields    ${verdict.missing.join(", ")}`);
  if (verdict.unknownStatuses.length > 0) {
    lines.push(
      `  unknown statuses  ${verdict.unknownStatuses.join(", ")}`,
      "                    (agents in these states are dropped, not rendered)",
    );
  }
  return [
    ...lines,
    `  herdr protocol    ${herdrProtocol}`,
    `  paddock built for ${HERDR_PROTOCOL}`,
    "",
    "  A field paddock reads has moved or gone. Regenerate the contract, then",
    "  re-check the one file that maps it:",
    "    make types",
    "    src/server/herdr/adapter.ts",
  ].join("\n");
}
