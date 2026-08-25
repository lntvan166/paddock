import { expect, test } from "bun:test";
import type {
  HerdrAgentRaw,
  HerdrPaneInfo,
  HerdrPaneRead,
  HerdrPaneReadResult,
  HerdrSessionSnapshot,
  HerdrStatusChanged,
  HerdrTabInfo,
  HerdrWorkspaceInfo,
  HerdrWorkspaceRaw,
} from "@shared/herdr-api";

// scripts/gen-herdr-types.ts derives only `protocol` and the AgentStatus enum
// from the schema; all three interface BODIES are hand-written. So the
// "generated types make a rename a build error" guarantee in docs/gotchas.md
// and docs/decisions.md rests entirely on this file, and it has to cover all
// three payload types to be worth what those docs claim. A rename in
// WorkspaceInfo.label would otherwise produce silently empty workspace
// labels, and one in the status-event payload a frozen task line — precisely
// the "a field is always empty" failure they say is eliminated.

// Every field HerdrAgentRaw declares, kept honest by the `satisfies` check
// below: adding or removing a field on HerdrAgentRaw without updating this
// object (or vice versa) is a tsc error, in both directions — `Record<K,
// true>` requires every key of K to be present, and `satisfies` still
// applies excess-property checking to the object literal, so an unlisted
// key also fails. This is the compile-time link the runtime side can't
// provide on its own, since `herdr-api.d.ts` is a declaration file and has
// no runtime representation to enumerate.
const DECLARED_FIELD_FLAGS = {
  agent: true,
  agent_status: true,
  agent_session: true,
  cwd: true,
  foreground_cwd: true,
  focused: true,
  name: true,
  pane_id: true,
  revision: true,
  state_change_seq: true,
  tab_id: true,
  terminal_id: true,
  terminal_title: true,
  terminal_title_stripped: true,
  workspace_id: true,
} satisfies Record<keyof HerdrAgentRaw, true>;

const DECLARED_FIELDS = Object.keys(DECLARED_FIELD_FLAGS) as (keyof HerdrAgentRaw)[];

// Fields the installed herdr's `AgentInfo` carries that paddock deliberately
// does not model (as of protocol 19). Named explicitly so a new upstream
// field shows up here as a decision to make, not a silently ignored column.
const IGNORED_FIELDS = [
  "display_agent",
  "interactive_ready",
  "launch_pending",
  "screen_detection_skipped",
  "state_labels",
  "title",
  "tokens",
] as const;

// Same compile-time link for the other two payload types paddock reads.
const DECLARED_WORKSPACE_FLAGS = {
  workspace_id: true,
  label: true,
  number: true,
} satisfies Record<keyof HerdrWorkspaceRaw, true>;

const DECLARED_WORKSPACE_FIELDS = Object.keys(
  DECLARED_WORKSPACE_FLAGS,
) as (keyof HerdrWorkspaceRaw)[];

const IGNORED_WORKSPACE_FIELDS = [
  "active_tab_id",
  "agent_status",
  "focused",
  "pane_count",
  "tab_count",
  "tokens",
  "worktree",
] as const;

const DECLARED_STATUS_FLAGS = {
  pane_id: true,
  workspace_id: true,
  agent_status: true,
  agent: true,
  display_agent: true,
  title: true,
  state_labels: true,
} satisfies Record<keyof HerdrStatusChanged, true>;

const DECLARED_STATUS_FIELDS = Object.keys(
  DECLARED_STATUS_FLAGS,
) as (keyof HerdrStatusChanged)[];

/** paddock models every field of this event, so nothing is ignored. */
const IGNORED_STATUS_FIELDS = [] as const;

// `agent.read` -> `{ type: "pane_read", read: PaneReadResult }`. paddock read
// `result.text` for the whole of v2 — a field on neither object — so every
// read returned "" and tap-to-answer silently fell back to free text. The
// envelope is modelled so that mistake is a compile error; this check keeps
// the payload half of it honest against the installed herdr.
const DECLARED_READ_FLAGS = {
  pane_id: true,
  workspace_id: true,
  tab_id: true,
  source: true,
  format: true,
  text: true,
  revision: true,
  truncated: true,
} satisfies Record<keyof HerdrPaneReadResult, true>;

const DECLARED_READ_FIELDS = Object.keys(
  DECLARED_READ_FLAGS,
) as (keyof HerdrPaneReadResult)[];

/** paddock models every field of PaneReadResult, so nothing is ignored. */
const IGNORED_READ_FIELDS = [] as const;

// The envelope half. `read` is the field the defect missed; pinning the
// discriminant and the payload key here means a rename of EITHER fails to
// compile, not just a rename inside the payload.
const DECLARED_READ_ENVELOPE_FLAGS = {
  type: true,
  read: true,
} satisfies Record<keyof HerdrPaneRead, true>;

const DECLARED_READ_ENVELOPE_FIELDS = Object.keys(
  DECLARED_READ_ENVELOPE_FLAGS,
) as (keyof HerdrPaneRead)[];

/**
 * The installed herdr's schema, or null when herdr is not present.
 *
 * These tests compare hand-written declarations against a LIVE herdr, so
 * without herdr there is nothing to compare and they must skip — with the
 * reason stated, not silently. CI runners have no herdr installed, and a
 * suite that fails there for an environmental reason trains everyone to
 * ignore a red build.
 *
 * The distinction from `immutable-cache.test.ts`, which deliberately FAILS
 * rather than skips when `dist/` is missing: CI can produce `dist/`, so a
 * skip there would hide a real gap on every run. CI cannot produce a herdr
 * installation. Skip only what the environment genuinely cannot supply.
 */
async function liveSchema(): Promise<any | null> {
  try {
    const proc = Bun.spawn(["herdr", "api", "schema", "--json"], {
      stdout: "pipe", stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0 || text.trim() === "") return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const HAVE_HERDR = (await liveSchema()) !== null;
if (!HAVE_HERDR) {
  console.info(
    "herdr-schema-drift: herdr not installed — drift checks skipped. " +
      "They compare paddock's hand-written types against a LIVE `herdr api schema`.",
  );
}

/**
 * Both halves of "has not drifted":
 *  - every field paddock declares is still a real property upstream (a rename
 *    or removal would otherwise read as undefined forever), and
 *  - every upstream property is either modeled or explicitly ignored (so a new
 *    field is a decision to make, not a silently dropped column).
 */
function expectNoDrift(
  liveProperties: string[],
  declared: readonly string[],
  ignored: readonly string[],
): void {
  for (const field of declared) expect(liveProperties).toContain(field);
  const known = new Set<string>([...declared, ...ignored]);
  expect(liveProperties.filter((property) => !known.has(property))).toEqual([]);
}

test.skipIf(!HAVE_HERDR)("HerdrAgentRaw has not drifted from the installed herdr's AgentInfo schema", async () => {
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.success_response.$defs.AgentInfo.properties),
    DECLARED_FIELDS,
    IGNORED_FIELDS,
  );
});

test.skipIf(!HAVE_HERDR)("HerdrWorkspaceRaw has not drifted from the installed herdr's WorkspaceInfo schema", async () => {
  // `label` is the whole reason paddock reads workspace.list. A rename here
  // renders every workspace label empty, with no error anywhere.
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.success_response.$defs.WorkspaceInfo.properties),
    DECLARED_WORKSPACE_FIELDS,
    IGNORED_WORKSPACE_FIELDS,
  );
});

test.skipIf(!HAVE_HERDR)("HerdrPaneReadResult has not drifted from the installed herdr's PaneReadResult schema", async () => {
  // `text` is the whole reason paddock calls agent.read. Reading it from the
  // wrong place is the defect this file now guards; a rename would put the
  // output pane and every parsed prompt back to empty with no error anywhere.
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.success_response.$defs.PaneReadResult.properties),
    DECLARED_READ_FIELDS,
    IGNORED_READ_FIELDS,
  );
});

test.skipIf(!HAVE_HERDR)("HerdrPaneRead has not drifted from the installed agent.read response envelope", async () => {
  // The variant of ResponseResult discriminated by `type: "pane_read"`. If
  // herdr ever renamed `read`, or moved `text` up onto the envelope, this is
  // the check that notices — the payload check above would still pass.
  const schema = await liveSchema();
  const variants: any[] = schema.schemas.success_response.$defs.ResponseResult.oneOf;
  const paneRead = variants.find((v) => v.properties?.type?.const === "pane_read");
  expect(paneRead).toBeDefined();
  expect(paneRead.properties.read.$ref).toBe(
    "#/schemas/success_response/$defs/PaneReadResult",
  );
  expectNoDrift(Object.keys(paneRead.properties), DECLARED_READ_ENVELOPE_FIELDS, []);
  // Both fields are required upstream, so paddock declaring them non-optional
  // is not an over-claim.
  expect(paneRead.required.sort()).toEqual(["read", "type"]);
});

test.skipIf(!HAVE_HERDR)("HerdrStatusChanged has not drifted from the installed pane.agent_status_changed payload", async () => {
  // This is the push path: a rename in `agent_status` or `title` freezes every
  // row's state or task line until the next healing reconcile papers over it.
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.subscription_event.$defs.PaneAgentStatusChangedEvent.properties),
    DECLARED_STATUS_FIELDS,
    IGNORED_STATUS_FIELDS,
  );
});

const DECLARED_TAB_FLAGS = {
  tab_id: true, workspace_id: true, label: true, number: true,
  agent_status: true, pane_count: true, focused: true,
} satisfies Record<keyof HerdrTabInfo, true>;

const DECLARED_TAB_FIELDS = Object.keys(DECLARED_TAB_FLAGS) as (keyof HerdrTabInfo)[];

/** paddock models every field TabInfo carries, so nothing is ignored. */
const IGNORED_TAB_FIELDS = [] as const;

const DECLARED_WORKSPACE_INFO_FLAGS = {
  workspace_id: true, label: true, number: true, active_tab_id: true,
  agent_status: true, pane_count: true, tab_count: true, focused: true,
} satisfies Record<keyof HerdrWorkspaceInfo, true>;

const DECLARED_WORKSPACE_INFO_FIELDS = Object.keys(
  DECLARED_WORKSPACE_INFO_FLAGS,
) as (keyof HerdrWorkspaceInfo)[];

// Fields the installed herdr's `WorkspaceInfo` (session.snapshot shape)
// carries that paddock deliberately does not model. Named explicitly so a
// new upstream field shows up here as a decision to make, not a silently
// ignored column.
const IGNORED_WORKSPACE_INFO_FIELDS = [
  "tokens",
  "worktree",
] as const;

const DECLARED_PANE_FLAGS = {
  pane_id: true, workspace_id: true, tab_id: true, agent: true,
  agent_status: true, cwd: true, focused: true, label: true,
  terminal_title: true, terminal_title_stripped: true, revision: true,
} satisfies Record<keyof HerdrPaneInfo, true>;

const DECLARED_PANE_FIELDS = Object.keys(DECLARED_PANE_FLAGS) as (keyof HerdrPaneInfo)[];

// Fields the installed herdr's `PaneInfo` (session.snapshot shape) carries
// that paddock deliberately does not model. `agent_session`, `foreground_cwd`
// and `terminal_id` are all modelled on `HerdrAgentRaw` — they are not
// missing from paddock's vocabulary, just not read off this particular
// object. `display_agent`, `state_labels`, `title` and `tokens` mirror the
// same fields already ignored on `HerdrAgentRaw` above. `scroll` is new.
const IGNORED_PANE_FIELDS = [
  "agent_session",
  "display_agent",
  "foreground_cwd",
  "scroll",
  "state_labels",
  "terminal_id",
  "title",
  "tokens",
] as const;

const DECLARED_SNAPSHOT_FLAGS = {
  workspaces: true, tabs: true, panes: true, agents: true,
} satisfies Record<keyof HerdrSessionSnapshot, true>;

const DECLARED_SNAPSHOT_FIELDS = Object.keys(
  DECLARED_SNAPSHOT_FLAGS,
) as (keyof HerdrSessionSnapshot)[];

// Fields the installed herdr's `SessionSnapshot` carries that paddock
// deliberately does not model: the four collections are the whole tree, and
// these are snapshot-level metadata `tree.ts` has no present use for.
const IGNORED_SNAPSHOT_FIELDS = [
  "focused_pane_id",
  "focused_tab_id",
  "focused_workspace_id",
  "layouts",
  "protocol",
  "version",
] as const;

test.skipIf(!HAVE_HERDR)("HerdrTabInfo has not drifted from the installed herdr's TabInfo schema", async () => {
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.success_response.$defs.TabInfo.properties),
    DECLARED_TAB_FIELDS,
    IGNORED_TAB_FIELDS,
  );
});

test.skipIf(!HAVE_HERDR)("HerdrWorkspaceInfo has not drifted from the installed herdr's WorkspaceInfo (snapshot) schema", async () => {
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.success_response.$defs.WorkspaceInfo.properties),
    DECLARED_WORKSPACE_INFO_FIELDS,
    IGNORED_WORKSPACE_INFO_FIELDS,
  );
});

test.skipIf(!HAVE_HERDR)("HerdrPaneInfo has not drifted from the installed herdr's PaneInfo schema", async () => {
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.success_response.$defs.PaneInfo.properties),
    DECLARED_PANE_FIELDS,
    IGNORED_PANE_FIELDS,
  );
});

test.skipIf(!HAVE_HERDR)("HerdrSessionSnapshot has not drifted from the installed herdr's SessionSnapshot schema", async () => {
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.success_response.$defs.SessionSnapshot.properties),
    DECLARED_SNAPSHOT_FIELDS,
    IGNORED_SNAPSHOT_FIELDS,
  );
});
