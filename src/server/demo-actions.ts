import type { HerdrActions } from "@server/herdr/actions";
import type { NavKey, SpaceTree } from "@shared/types";
import { DEMO_BLOCKED_AGENT_ID, DEMO_HOST_ID } from "@server/demo";

/**
 * The herdr a demo does not have.
 *
 * `--demo` used to leave `HerdrActions` unset entirely, so every route that
 * needed one was never registered and answered 404. That was honest, and it
 * had a real cost recorded in `CLAUDE.md`: the terminal pane and both Spaces
 * screens rendered as errors, so there was NO permitted source of a screenshot
 * for the two screens that show what paddock is for.
 *
 * This is the shim that file asks for — "serves synthetic reads and refuses
 * writes with a plain 'this is the demo' message" — and its warning is the
 * whole design constraint:
 *
 *   > not worth doing carelessly, because a demo whose keys appear to work and
 *   > do nothing is exactly the mislabelled control this file bans elsewhere.
 *
 * So every WRITE throws. It does not resolve quietly, and it does not pretend
 * to have sent something. A thrown error reaches the route's existing
 * catch, which returns a 502 carrying the message, which the UI already knows
 * how to show — the same path a real herdr failure takes. The operator sees
 * "this is the demo", not a keystroke that vanished.
 *
 * Reads are synthetic and INVENTED, like every other demo fixture: this is the
 * one mode README media comes from, so nothing here may resemble real data.
 */

/** The transcript for the blocked agent — a permission prompt, which is the
 *  one moment the whole application exists for. Invented, and deliberately
 *  boring: a migration nobody has to think about, so the screenshot is about
 *  paddock rather than about the migration. */
const BLOCKED_TRANSCRIPT: string[] = [
  "  Reviewed the migration and its rollback path.",
  "",
  "  The change adds one index and backfills in batches, so it can run",
  "  online. Rollback is a single DROP INDEX, with no data loss.",
  "",
  "  Findings",
  "",
  "  ┌────────────────┬───────────┬──────────────────────┐",
  "  │ Table          │      Rows │ Effect               │",
  "  ├────────────────┼───────────┼──────────────────────┤",
  "  │ sessions       │ 1,204,882 │ index only, no rewrite│",
  "  │ audit_entries  │   118,430 │ backfilled in batches │",
  "  │ feature_flags  │       612 │ untouched             │",
  "  └────────────────┴───────────┴──────────────────────┘",
  "",
  "  Estimated runtime on staging: ~4 minutes.",
  "",
  "  Bash command",
  "",
  "    bun run migrate --env staging",
  "    Apply the pending migration to staging",
  "",
  "  This command requires approval",
  "",
  "  Do you want to proceed?",
  "  ❯ 1. Yes",
  "    2. Yes, and don't ask again for: bun run migrate *",
  "    3. No",
  "",
  "  Esc to cancel · Tab to amend",
];

/** What a working agent's pane shows. */
const WORKING_TRANSCRIPT: string[] = [
  "  Extracting the auth middleware.",
  "",
  "  ✓ moved requireSession into middleware/auth.ts",
  "  ✓ updated 14 call sites",
  "  · running the suite …",
  "",
  "    PASS  tests/auth.test.ts",
  "    PASS  tests/routes.test.ts",
];

/** An idle agent's pane: a shell prompt with nothing after it. */
const IDLE_TRANSCRIPT: string[] = [
  "  Rewrote the getting-started guide.",
  "",
  "  Nothing left to do — waiting for the next instruction.",
];

/**
 * The blocked agent's raw detection text.
 *
 * The prompt parser reads THIS, not the transcript, and the demo must exercise
 * the real parser rather than hand it a pre-parsed answer — otherwise the
 * screenshot would show option buttons the live code might not produce. Same
 * bytes as the tail of `BLOCKED_TRANSCRIPT`, for the same reason.
 */
const BLOCKED_DETECTION = [
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for: bun run migrate *",
  "  3. No",
].join("\n");

/** Imported rather than repeated: `demo.ts`'s `tick` must leave the SAME
 *  agent alone that this file serves a prompt for, and two literals is how
 *  those quietly stop being the same agent. */
const BLOCKED_ID = DEMO_BLOCKED_AGENT_ID;

/** Refused, never silently accepted. See the note at the top of this file. */
function refuse(): never {
  throw new Error("this is the demo — paddock has no herdr here, so nothing was sent");
}

export function demoActions(): HerdrActions {
  return {
    async readOutput(target) {
      return { lines: transcriptFor(target), source: "visible" as const };
    },
    async readPane(paneId) {
      return { lines: transcriptFor(paneId), source: "visible" as const };
    },
    async readDetection(target) {
      return target === BLOCKED_ID ? BLOCKED_DETECTION : "";
    },

    // Every write below refuses. None of them resolves.
    async sendOptionKey(_target: string, _key: string) { refuse(); },
    async sendNavKey(_target: string, _key: NavKey) { refuse(); },
    async sendReply(_target: string, _text: string) { refuse(); },
    async sendPaneText(_paneId: string, _text: string) { refuse(); },
    async sendPaneKey(_paneId: string, _key: NavKey) { refuse(); },
    async waitUntilUnblocked() { refuse(); },
    async renameAgent() { refuse(); },
    async renameTab() { refuse(); },
    async renameSpace() { refuse(); },
    async closeTab() { refuse(); },
    async closeSpace() { refuse(); },
    async createSpace() { refuse(); },
    async createTab() { refuse(); },
    async startAgent() { refuse(); },

    // A READ, so it answers: the create sheet's harness picker is populated
    // and looks like itself. The create it leads to still refuses.
    async harnessKinds() { return ["claude", "codex"]; },
  };
}

function transcriptFor(target: string): string[] {
  if (target === BLOCKED_ID) return BLOCKED_TRANSCRIPT;
  if (target === "d3:p1" || target === "d4:p1") return WORKING_TRANSCRIPT;
  return IDLE_TRANSCRIPT;
}

/**
 * The session tree, so both Spaces screens render instead of erroring.
 *
 * Built from the same six agents `demoAgents` seeds, one space per agent plus
 * one shell-only space — enough structure to show what the screen is for (a
 * space holding a tab holding a pane, and a pane with no agent) without
 * inventing a herd nobody would have.
 */
export function demoTree(now: number): SpaceTree {
  const of = (
    id: string, label: string, harness: string | null, name: string | null,
    title: string | null, state: SpaceTree["spaces"][number]["tabs"][number]["panes"][number]["state"],
  ) => ({
    spaceId: id,
    label,
    tabCount: 1,
    paneCount: 1,
    tabs: [{
      tabId: `${id}:t1`,
      // Unlabelled, which is the common case on a real herd: herdr returns the
      // tab's number, and paddock reads that as "never named".
      label: null,
      panes: [{ paneId: `${id}:p1`, harness, name, title, cwd: "~/demo-project", state }],
    }],
  });

  return {
    readAt: now,
    spaces: [
      of("d1", "schema migration", "claude", "schema-migration", "Apply migration to staging", "blocked"),
      of("d2", "lint config", "codex", "lint-config", "Align eslint with the style guide", "done"),
      of("d3", "api refactor", "claude", "api-refactor", "Extract auth middleware", "working"),
      of("d4", "perf audit", "codex", "perf-audit", "Profile the request path", "working"),
      of("d5", "docs cleanup", "claude", "docs-cleanup", "Rewrite the getting-started guide", "idle"),
      of("d6", "flaky test fix", "codex", "flaky-test-fix", "Stabilise the upload suite", "idle"),
      // A pane with no agent, so the screen shows both kinds. Labelled by its
      // folder rather than its terminal title — `shellLabel`'s rule, and the
      // reason a demo must not seed a prompt-shaped title here.
      of("d7", "scratch", null, null, null, null),
    ],
  };
}

export { DEMO_HOST_ID };
