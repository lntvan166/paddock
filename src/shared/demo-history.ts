/**
 * The one invented "Show earlier" transcript both demo hosts show.
 *
 * paddock has two independent demo backends — the CLI's `paddock --demo`
 * (`server/demo.ts`, a real server with synthetic agents) and the static
 * GitHub Pages build (`web/demo/backend.ts`, a synthetic backend running
 * entirely in the browser). Both need to demonstrate journal history for
 * screenshots, and both must tell the SAME invented story rather than two
 * that could drift apart one edit at a time — so the content lives here,
 * imported by both, and neither file declares its own copy.
 *
 * Every line is invented, per house rule 2 (this repository is public).
 * `flaky-test-fix` is the only proper noun, drawn from the approved fixture
 * name set, and matches the seeded agent's task ("Stabilise the upload
 * suite") in both demo hosts.
 */

/** The one seeded demo agent, in both hosts, whose session log can be "read". */
export const DEMO_JOURNAL_AGENT_ID = "d6:p1";

/**
 * The transcript, already in the shape `toLines` produces
 * (`server/journal/text.ts`): a speaker line, an optional tool-summary line,
 * prose, then a blank line between turns.
 */
export const DEMO_JOURNAL_LINES: string[] = [
  "you · 13:04",
  "the flaky-test-fix suite times out about one run in five — can you dig in?",
  "",
  "agent · 13:05",
  "▸ Bash · run the suite three times",
  "Reproduced it on the second run: the retry budget is exhausted before the " +
    "first assertion fires, so the harness treats a slow fixture boot as a failure.",
  "",
  "you · 13:08",
  "is it the fixture or the assertion timeout?",
  "",
  "agent · 13:09",
  "▸ Read · tests/fixtures/upload.ts",
  "The fixture waits on a fake clock that only advances on tick(); the suite's " +
    "timeout is real wall time. Bumping the tick interval should fix it without " +
    "touching the assertion.",
  "",
];
