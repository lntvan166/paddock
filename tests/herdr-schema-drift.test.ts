import { expect, test } from "bun:test";
import type { HerdrAgentRaw, HerdrStatusChanged, HerdrWorkspaceRaw } from "@shared/herdr-api";

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
  "agent_session",
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

async function liveSchema(): Promise<any> {
  const proc = Bun.spawn(["herdr", "api", "schema", "--json"], { stdout: "pipe" });
  return JSON.parse(await new Response(proc.stdout).text());
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

test("HerdrAgentRaw has not drifted from the installed herdr's AgentInfo schema", async () => {
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.success_response.$defs.AgentInfo.properties),
    DECLARED_FIELDS,
    IGNORED_FIELDS,
  );
});

test("HerdrWorkspaceRaw has not drifted from the installed herdr's WorkspaceInfo schema", async () => {
  // `label` is the whole reason paddock reads workspace.list. A rename here
  // renders every workspace label empty, with no error anywhere.
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.success_response.$defs.WorkspaceInfo.properties),
    DECLARED_WORKSPACE_FIELDS,
    IGNORED_WORKSPACE_FIELDS,
  );
});

test("HerdrStatusChanged has not drifted from the installed pane.agent_status_changed payload", async () => {
  // This is the push path: a rename in `agent_status` or `title` freezes every
  // row's state or task line until the next healing reconcile papers over it.
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.subscription_event.$defs.PaneAgentStatusChangedEvent.properties),
    DECLARED_STATUS_FIELDS,
    IGNORED_STATUS_FIELDS,
  );
});
