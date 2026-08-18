/**
 * Synthetic terminal screens for the browser demo.
 *
 * Every agent name, path and line here is INVENTED. `CLAUDE.md` calls this the
 * rule most likely to be broken by accident — "a reviewer notices a hardcoded
 * hostname, but nobody notices that a demo fixture is named after someone's
 * internal tickets" — and demo data is exactly where that happens. Nothing in
 * this file is copied from a real session, and nothing here may ever be.
 *
 * The content is chosen to exercise the features worth showing rather than to
 * look busy: coloured prose, a box-drawn table whose columns must not reflow,
 * a progress bar, a separator, and a permission prompt whose middle option is
 * a persistent grant.
 */

const E = "";
const dim = (s: string) => `${E}[38;2;136;136;136m${s}${E}[0m`;
const white = (s: string) => `${E}[38;2;255;255;255m${s}${E}[0m`;
const bold = (s: string) => `${E}[1m${s}${E}[0m`;
const green = (s: string) => `${E}[38;2;63;185;80m${s}${E}[0m`;
const blue = (s: string) => `${E}[38;2;94;106;210m${s}${E}[0m`;
const amber = (s: string) => `${E}[38;2;224;168;56m${s}${E}[0m`;

/**
 * A blocked agent, mid-permission-prompt. The headline screen.
 *
 * Built from the cursor position rather than fixed, so the demo's arrow keys
 * move the agent's own `❯` exactly as they do against a real pane — which is
 * the whole point of the keypad and of the preview above it.
 */
export function blockedScreen(selected = 0): string[] {
  const options = [
    "1. Yes",
    "2. Yes, and don't ask again for: bun run migrate *",
    "3. No",
  ];
  return [
    ...BLOCKED_PRELUDE,
    ...options.map((o, i) => (i === selected ? `❯ ${o}` : `  ${o}`)),
    "",
    dim("Esc to cancel · Tab to amend · ctrl+e to explain"),
  ];
}

const BLOCKED_PRELUDE: string[] = [
  green("●") + " Reviewed the migration and the rollback path.",
  "",
  "  The change adds one index and backfills in batches, so it can run",
  "  online. Rollback is a single " + blue("DROP INDEX") + ", no data loss.",
  "",
  bold("  Findings"),
  "",
  "  ┌──────────────────────┬────────────┬──────────────────────────────┐",
  "  │        Table         │    Rows    │            Effect            │",
  "  ├──────────────────────┼────────────┼──────────────────────────────┤",
  "  │ " + white("sessions") + "             │  1,204,882 │ index only, no rewrite       │",
  "  │ " + white("audit_entries") + "        │    118,430 │ backfilled in 500-row batches │",
  "  │ " + white("feature_flags") + "        │        612 │ untouched                    │",
  "  └──────────────────────┴────────────┴──────────────────────────────┘",
  "",
  "  Estimated runtime on staging: " + amber("~4 minutes") + ".",
  "",
  dim("✻ Considered for 38s"),
  "",
  bold("Bash command"),
  "",
  "  " + blue("bun run migrate --env staging"),
  "  Apply the pending migration to staging",
  "",
  "This command requires approval",
  "",
  "Do you want to proceed?",
];

/** A working agent, mid-thought. Shows the spinner and token counter. */
export const WORKING_SCREEN: string[] = [
  green("●") + " Extracting the auth middleware.",
  "",
  "  Moved token parsing out of the request handler and behind a single",
  "  " + blue("requireSession()") + " guard, so the handler no longer knows how a",
  "  session is represented.",
  "",
  "  " + dim("Ran 2 shell commands"),
  "",
  green("●") + " " + bold("Tests pass") + " — 84 of 84, no new warnings.",
  "",
  "  Remaining: the websocket upgrade path still parses its own token.",
  "  Folding that in next.",
  "",
  dim("✻ Refactoring… (1m 12s · ↓ 3.4k tokens)"),
  "",
  "─".repeat(78),
  "❯ ",
  "─".repeat(78),
  "  " + dim("Opus 5") + "  " + green("████████") + dim("░░░░░░░░░░░░") + "  " + dim("38%"),
  "  " + amber("⏵⏵ auto mode on") + dim(" (shift+tab to cycle) · esc to interrupt"),
];

/** A finished agent. */
export const DONE_SCREEN: string[] = [
  green("●") + " " + bold("Done.") + " Style guide alignment complete.",
  "",
  "  Updated 41 files. The only behavioural change is stricter import",
  "  ordering, which the formatter now enforces.",
  "",
  "  " + dim("Ran 1 shell command"),
  "",
  dim("✻ Finished in 2m 04s"),
  "",
  "─".repeat(78),
  "❯ ",
  "─".repeat(78),
];

export const IDLE_SCREEN: string[] = [
  dim("  Waiting for instructions."),
  "",
  "  " + dim("Last run finished 15 minutes ago.") ,
  "",
  "─".repeat(78),
  "❯ ",
  "─".repeat(78),
];

export const SCREENS: Record<string, string[]> = {
  "d1:p1": blockedScreen(),
  "d2:p1": DONE_SCREEN,
  "d3:p1": WORKING_SCREEN,
  "d4:p1": WORKING_SCREEN,
  "d5:p1": IDLE_SCREEN,
  "d6:p1": IDLE_SCREEN,
};

/**
 * The prompt a blocked agent is showing, in the shape `parsePrompt` produces.
 *
 * The middle option is a PERSISTENT grant, deliberately: it is the case the
 * "Enter selects" preview exists for, and a demo that only showed
 * yes/no would not show why any of that design is there.
 */
export const DEMO_OPTIONS = [
  { key: "1", label: "Yes", selected: true },
  { key: "2", label: "Yes, and don't ask again for: bun run migrate *", selected: false },
  { key: "3", label: "No", selected: false },
];
