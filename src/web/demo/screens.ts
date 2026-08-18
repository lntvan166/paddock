/**
 * Synthetic terminal screens for the browser demo.
 *
 * Every agent name, path and line here is INVENTED. `CLAUDE.md` calls this the
 * rule most likely to be broken by accident — "a reviewer notices a hardcoded
 * hostname, but nobody notices that a demo fixture is named after someone's
 * internal tickets" — and demo data is exactly where that happens. Nothing in
 * this file is copied from a real session, and nothing here may ever be.
 *
 * The content exercises what is worth showing rather than filling space: a
 * box-drawn table whose columns must not reflow, a progress bar, separators,
 * and a permission prompt whose middle option is a persistent grant.
 */

const E = "";
const paint = (code: string) => (s: string) => `${E}[${code}m${s}${E}[0m`;
const dim = paint("38;2;136;136;136");
const white = paint("38;2;255;255;255");
const bold = paint("1");
const green = paint("38;2;63;185;80");
const blue = paint("38;2;94;106;210");
const amber = paint("38;2;224;168;56");
const red = paint("38;2;248;81;73");

/**
 * Build a box-drawn table with guaranteed alignment.
 *
 * Cells are padded as PLAIN text and coloured afterwards, because colour codes
 * carry no visible width: padding a string that already contains escapes
 * counts the escapes as characters and every row ends up a different length.
 * The first version of this table was hand-written and did exactly that — one
 * cell overflowed its column and pushed a stray `│` past the right border,
 * which is precisely the "looks broken" that a demo cannot afford.
 */
type Cell = { text: string; colour?: (s: string) => string; align?: "left" | "right" | "centre" };

function row(cells: Cell[], widths: number[], edge: [string, string, string]): string {
  const parts = cells.map((c, i) => {
    const w = widths[i]!;
    const t = c.text.length > w ? c.text.slice(0, w - 1) + "…" : c.text;
    const pad = w - t.length;
    const padded =
      c.align === "right" ? " ".repeat(pad) + t
      : c.align === "centre" ? " ".repeat(Math.floor(pad / 2)) + t + " ".repeat(Math.ceil(pad / 2))
      : t + " ".repeat(pad);
    return c.colour ? c.colour(padded) : padded;
  });
  return `  ${edge[0]}${parts.join(edge[1])}${edge[2]}`;
}

function rule(widths: number[], edge: [string, string, string]): string {
  return `  ${edge[0]}${widths.map((w) => "─".repeat(w)).join(edge[1])}${edge[2]}`;
}

const COLS = [22, 12, 30];

function demoTable(): string[] {
  const cells = (texts: string[], colour?: (s: string) => string): Cell[] => [
    { text: ` ${texts[0]} `, colour },
    { text: `${texts[1]} `, align: "right", colour },
    { text: ` ${texts[2]} ` },
  ];
  return [
    rule(COLS, ["┌", "┬", "┐"]),
    row(
      [
        { text: "Table", align: "centre" },
        { text: "Rows", align: "centre" },
        { text: "Effect", align: "centre" },
      ],
      COLS,
      ["│", "│", "│"],
    ),
    rule(COLS, ["├", "┼", "┤"]),
    row(cells(["sessions", "1,204,882", "index only, no rewrite"], white), COLS, ["│", "│", "│"]),
    row(cells(["audit_entries", "118,430", "backfilled in batches"], white), COLS, ["│", "│", "│"]),
    row(cells(["feature_flags", "612", "untouched"], white), COLS, ["│", "│", "│"]),
    rule(COLS, ["└", "┴", "┘"]),
  ];
}

const SEP = "─".repeat(78);
const inputBox = (): string[] => [SEP, "❯ ", SEP];

/**
 * A blocked agent, mid-permission-prompt. The headline screen.
 *
 * Built from the cursor position rather than fixed, so the demo's arrow keys
 * move the agent's own `❯` exactly as they do against a real pane — which is
 * what the keypad and the preview above it exist for.
 */
export function blockedScreen(selected = 0): string[] {
  const options = [
    "1. Yes",
    "2. Yes, and don't ask again for: bun run migrate *",
    "3. No",
  ];
  return [
    green("●") + " Reviewed the migration and its rollback path.",
    "",
    "  The change adds one index and backfills in batches, so it can run",
    "  online. Rollback is a single " + blue("DROP INDEX") + ", with no data loss.",
    "",
    bold("  Findings"),
    "",
    ...demoTable(),
    "",
    "  Estimated runtime on staging: " + amber("~4 minutes") + ".",
    "",
    dim("✻ Considered for 38s"),
    "",
    bold("Bash command"),
    "",
    "  " + blue("bun run migrate --env staging"),
    "  " + dim("Apply the pending migration to staging"),
    "",
    "This command requires approval",
    "",
    "Do you want to proceed?",
    ...options.map((o, i) => (i === selected ? `❯ ${o}` : `  ${o}`)),
    "",
    dim("Esc to cancel · Tab to amend · ctrl+e to explain"),
  ];
}

/** Mid-thought. The spinner and token counter animate; nothing else moves. */
export const WORKING_SCREEN: string[] = [
  green("●") + " Extracting the auth middleware.",
  "",
  "  Token parsing moved out of the request handler and behind a single",
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
  ...inputBox(),
  "  " + dim("Opus 5") + "  " + green("████████") + dim("░░░░░░░░░░░░") + "  " + dim("38%"),
  "  " + amber("⏵⏵ auto mode on") + dim(" (shift+tab to cycle) · esc to interrupt"),
];

/** A second working agent, so two are not identical on screen. */
export const PROFILING_SCREEN: string[] = [
  green("●") + " Profiling the request path under load.",
  "",
  "  " + dim("Ran 1 shell command"),
  "",
  "  " + bold("Hot spots") + " at 500 rps:",
  "",
  "    " + amber("41%") + "  " + white("serialiseAgent()") + dim("        — re-encodes unchanged rows"),
  "    " + amber("18%") + "  " + white("parseCookies()") + dim("          — called twice per request"),
  "    " + dim(" 9%") + "  " + white("json()") + dim("                   — unavoidable"),
  "",
  "  The first is worth fixing; the second is a one-line hoist.",
  "",
  dim("✻ Measuring… (2m 05s · ↓ 6.1k tokens)"),
  "",
  ...inputBox(),
  "  " + dim("Opus 5") + "  " + green("█████") + dim("░░░░░░░░░░░░░░░") + "  " + dim("24%"),
  "  " + amber("⏵⏵ auto mode on") + dim(" (shift+tab to cycle) · esc to interrupt"),
];

/** Finished, and not yet dismissed. */
export const DONE_SCREEN: string[] = [
  green("●") + " " + bold("Done.") + " Style guide alignment complete.",
  "",
  "  Updated 41 files. The only behavioural change is stricter import",
  "  ordering, which the formatter now enforces.",
  "",
  "  " + green("✓") + " " + white("41 files") + dim(" reformatted"),
  "  " + green("✓") + " " + white("0 lint errors") + dim(" remaining (was 137)"),
  "  " + red("!") + " " + white("2 rules disabled") + dim(" with an inline reason"),
  "",
  "  " + dim("Ran 1 shell command"),
  "",
  dim("✻ Finished in 2m 04s"),
  "",
  ...inputBox(),
];

export const IDLE_DOCS_SCREEN: string[] = [
  green("●") + " Rewrote the getting-started guide.",
  "",
  "  Cut it from nine steps to four by removing the parts that only",
  "  applied to the old CLI.",
  "",
  "  " + dim("Ran 2 shell commands"),
  "",
  dim("✻ Finished 15 minutes ago · waiting for instructions"),
  "",
  ...inputBox(),
];

export const IDLE_FLAKY_SCREEN: string[] = [
  green("●") + " Stabilised the upload suite.",
  "",
  "  Three tests shared a temp directory and raced when run in parallel.",
  "  Each now gets its own, created and removed per test.",
  "",
  "  " + green("✓") + " " + white("200 consecutive runs") + dim(" with no failure"),
  "",
  "  " + dim("Ran 4 shell commands"),
  "",
  dim("✻ Finished an hour ago · waiting for instructions"),
  "",
  ...inputBox(),
];

export const SCREENS: Record<string, string[]> = {
  "d1:p1": blockedScreen(),
  "d2:p1": DONE_SCREEN,
  "d3:p1": WORKING_SCREEN,
  "d4:p1": PROFILING_SCREEN,
  "d5:p1": IDLE_DOCS_SCREEN,
  "d6:p1": IDLE_FLAKY_SCREEN,
};

/**
 * The options a blocked agent is showing.
 *
 * The middle one is a PERSISTENT grant, deliberately: it is the case the
 * "Enter selects" preview exists for, and a demo showing only yes/no would not
 * show why any of that design is there.
 */
export const DEMO_OPTIONS = [
  { key: "1", label: "Yes", selected: true },
  { key: "2", label: "Yes, and don't ask again for: bun run migrate *", selected: false },
  { key: "3", label: "No", selected: false },
];
