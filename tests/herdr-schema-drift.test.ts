import { expect, test } from "bun:test";
import type {
  HerdrAgentManifest,
  HerdrAgentManifests,
  HerdrAgentRaw,
  HerdrAgentStarted,
  HerdrPaneInfo,
  HerdrPaneRead,
  HerdrPaneReadResult,
  HerdrSessionSnapshot,
  HerdrStatusChanged,
  HerdrTabCreated,
  HerdrTabInfo,
  HerdrWorkspaceCreated,
  HerdrWorkspaceInfo,
  HerdrWorkspaceRaw,
  HerdrAgentSendKeysParams,
  HerdrAgentPromptParams,
  HerdrAgentWaitParams,
  HerdrAgentReadParams,
  HerdrOk,
  HerdrAgentPrompted,
  HerdrAgentWaited,
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

// `pane.read` needs no test of its own, and its absence is not an omission:
// herdr shares the `PaneReadResult` `$def` between `agent.read` and
// `pane.read`, so the two tests above already pin both methods' payload and
// envelope. Recorded because the design's §5 checklist names `pane.read`
// explicitly, and a reader looking for that test and not finding it would
// otherwise add a redundant second copy of this one.
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

// `HerdrAgentManifest` models one entry of `server.agent_manifests`'s
// `manifests[]`. Unlike the four envelopes below, its upstream shape IS a
// named `$def` — `AgentManifestInfo` — so it gets the same bidirectional
// treatment as every payload type above.
const DECLARED_AGENT_MANIFEST_FLAGS = {
  agent: true,
} satisfies Record<keyof HerdrAgentManifest, true>;

const DECLARED_AGENT_MANIFEST_FIELDS = Object.keys(
  DECLARED_AGENT_MANIFEST_FLAGS,
) as (keyof HerdrAgentManifest)[];

// Fields the installed herdr's `AgentManifestInfo` carries that paddock
// deliberately does not model (protocol 20). paddock reads only `agent` —
// the harness name §9.3 uses to build the kind allowlist at runtime, never
// hardcoded. Everything else here is metadata about herdr's own
// update-checking machinery (cached remote version, last-checked timestamp,
// update errors/results, override shadowing, source and its kind, a
// warning string) that paddock has no present use for. Named explicitly so
// a new field upstream is a decision to make, not a silently dropped
// column — this is the live protocol-20 property list, not a transcription
// from the task brief that first proposed this type, which undercounted it
// (8 properties; the live schema has 10).
const IGNORED_AGENT_MANIFEST_FIELDS = [
  "active_version",
  "cached_remote_version",
  "local_override_shadowing_remote",
  "remote_last_checked_unix",
  "remote_update_error",
  "remote_update_result",
  "source",
  "source_kind",
  "warning",
] as const;

test.skipIf(!HAVE_HERDR)("HerdrAgentManifest has not drifted from the installed herdr's AgentManifestInfo schema", async () => {
  // `agent` is the whole reason paddock reads this. A rename here would make
  // §9.3's kind allowlist come back empty on every machine, silently — no
  // kinds to start, with no error anywhere.
  const schema = await liveSchema();
  expectNoDrift(
    Object.keys(schema.schemas.success_response.$defs.AgentManifestInfo.properties),
    DECLARED_AGENT_MANIFEST_FIELDS,
    IGNORED_AGENT_MANIFEST_FIELDS,
  );
});

// `HerdrTabCreated`, `HerdrWorkspaceCreated`, `HerdrAgentStarted` and
// `HerdrAgentManifests` are the ENVELOPES for `tab.create`, `workspace.create`,
// `agent.start` and `server.agent_manifests`. None of the four is a named
// top-level `$def` in `herdr api schema --json` — but all four are still
// live-checkable: they exist as anonymous members of
// `success_response.$defs.ResponseResult`'s `oneOf`, discriminated by
// `properties.type.const`, exactly the technique `HerdrPaneRead`'s test
// above already uses for `pane_read`. An earlier pass at this file treated
// "not a named $def" as "nothing to compare against" and self-referentially
// pinned these four against hand-written literals in this same file —
// which cannot detect upstream drift at all, the one protection this task
// exists to add. Corrected here: each of the four now gets its own
// `expectNoDrift` against the live `oneOf` member, the same as every
// payload type above.
//
// §9.1 originally read `TabInfo` — a real `$def` with no `pane_id` — and
// concluded from that alone that `tab.create`'s whole response has no pane
// id, prescribing a snapshot re-read to find the new pane. A probe
// (`docs/probes/2026-08-25-structural-events.md`) measured that false for
// `tab.create` and `workspace.create`: the pane arrives on the envelope as
// `root_pane`. `agent_started`'s envelope shape was NOT captured by that
// probe — it only ever drove workspace/tab create-rename-close traffic —
// so `agent_started`'s shape below is cited to this live schema instead.
// That distinction matters: citing a source for a claim it never made is
// the same class of defect as reading a `$defs` entry as though it were
// the whole response — both are "the document says so" without checking
// what the document actually says.

const DECLARED_TAB_CREATED_FLAGS = {
  type: true,
  tab: true,
  root_pane: true,
} satisfies Record<keyof HerdrTabCreated, true>;

const DECLARED_TAB_CREATED_FIELDS = Object.keys(
  DECLARED_TAB_CREATED_FLAGS,
) as (keyof HerdrTabCreated)[];

/** paddock models every field the live `tab_created` variant carries. */
const IGNORED_TAB_CREATED_FIELDS = [] as const;

test.skipIf(!HAVE_HERDR)("HerdrTabCreated has not drifted from the installed herdr's tab_created response variant", async () => {
  // Measured live, docs/probes/2026-08-25-structural-events.md: the new
  // pane arrives here as `root_pane`, not found by re-reading the snapshot
  // as §9.1 originally (and wrongly) prescribed.
  const schema = await liveSchema();
  const variants: any[] = schema.schemas.success_response.$defs.ResponseResult.oneOf;
  const tabCreated = variants.find((v) => v.properties?.type?.const === "tab_created");
  expect(tabCreated).toBeDefined();
  expect(tabCreated.properties.tab.$ref).toBe("#/schemas/success_response/$defs/TabInfo");
  expect(tabCreated.properties.root_pane.$ref).toBe("#/schemas/success_response/$defs/PaneInfo");
  expectNoDrift(
    Object.keys(tabCreated.properties),
    DECLARED_TAB_CREATED_FIELDS,
    IGNORED_TAB_CREATED_FIELDS,
  );
});

const DECLARED_WORKSPACE_CREATED_FLAGS = {
  type: true,
  workspace: true,
  tab: true,
  root_pane: true,
} satisfies Record<keyof HerdrWorkspaceCreated, true>;

const DECLARED_WORKSPACE_CREATED_FIELDS = Object.keys(
  DECLARED_WORKSPACE_CREATED_FLAGS,
) as (keyof HerdrWorkspaceCreated)[];

/** paddock models every field the live `workspace_created` variant carries. */
const IGNORED_WORKSPACE_CREATED_FIELDS = [] as const;

test.skipIf(!HAVE_HERDR)("HerdrWorkspaceCreated has not drifted from the installed herdr's workspace_created response variant", async () => {
  // Measured live, docs/probes/2026-08-25-structural-events.md: same
  // envelope shape as tab_created, one level up.
  const schema = await liveSchema();
  const variants: any[] = schema.schemas.success_response.$defs.ResponseResult.oneOf;
  const workspaceCreated = variants.find((v) => v.properties?.type?.const === "workspace_created");
  expect(workspaceCreated).toBeDefined();
  expect(workspaceCreated.properties.workspace.$ref).toBe(
    "#/schemas/success_response/$defs/WorkspaceInfo",
  );
  expect(workspaceCreated.properties.tab.$ref).toBe("#/schemas/success_response/$defs/TabInfo");
  expect(workspaceCreated.properties.root_pane.$ref).toBe(
    "#/schemas/success_response/$defs/PaneInfo",
  );
  expectNoDrift(
    Object.keys(workspaceCreated.properties),
    DECLARED_WORKSPACE_CREATED_FIELDS,
    IGNORED_WORKSPACE_CREATED_FIELDS,
  );
});

const DECLARED_AGENT_STARTED_FLAGS = {
  type: true,
  agent: true,
} satisfies Record<keyof HerdrAgentStarted, true>;

const DECLARED_AGENT_STARTED_FIELDS = Object.keys(
  DECLARED_AGENT_STARTED_FLAGS,
) as (keyof HerdrAgentStarted)[];

// `argv` — the argv herdr launched the harness with — is required upstream
// (protocol 20) but paddock's `agent.start` caller has no present use for
// it. NOT measured by docs/probes/2026-08-25-structural-events.md, which
// only ever captured workspace/tab create-rename-close traffic; read
// directly off this live schema instead.
const IGNORED_AGENT_STARTED_FIELDS = ["argv"] as const;

test.skipIf(!HAVE_HERDR)("HerdrAgentStarted has not drifted from the installed herdr's agent_started response variant", async () => {
  const schema = await liveSchema();
  const variants: any[] = schema.schemas.success_response.$defs.ResponseResult.oneOf;
  const agentStarted = variants.find((v) => v.properties?.type?.const === "agent_started");
  expect(agentStarted).toBeDefined();
  expect(agentStarted.properties.agent.$ref).toBe("#/schemas/success_response/$defs/AgentInfo");
  expectNoDrift(
    Object.keys(agentStarted.properties),
    DECLARED_AGENT_STARTED_FIELDS,
    IGNORED_AGENT_STARTED_FIELDS,
  );
});

const DECLARED_AGENT_MANIFESTS_FLAGS = {
  type: true,
  manifests: true,
} satisfies Record<keyof HerdrAgentManifests, true>;

const DECLARED_AGENT_MANIFESTS_FIELDS = Object.keys(
  DECLARED_AGENT_MANIFESTS_FLAGS,
) as (keyof HerdrAgentManifests)[];

// `last_check_unix` and `last_result` describe herdr's own background
// update-check run as a whole, not any individual manifest — paddock reads
// only `manifests`, to build §9.3's kind allowlist at runtime. Read
// directly off this live schema, same as `argv` above.
const IGNORED_AGENT_MANIFESTS_FIELDS = ["last_check_unix", "last_result"] as const;

test.skipIf(!HAVE_HERDR)("HerdrAgentManifests has not drifted from the installed herdr's agent_manifest_status response variant", async () => {
  const schema = await liveSchema();
  const variants: any[] = schema.schemas.success_response.$defs.ResponseResult.oneOf;
  const manifestStatus = variants.find((v) => v.properties?.type?.const === "agent_manifest_status");
  expect(manifestStatus).toBeDefined();
  expect(manifestStatus.properties.manifests.items.$ref).toBe(
    "#/schemas/success_response/$defs/AgentManifestInfo",
  );
  expectNoDrift(
    Object.keys(manifestStatus.properties),
    DECLARED_AGENT_MANIFESTS_FIELDS,
    IGNORED_AGENT_MANIFESTS_FIELDS,
  );
});

// ---- the WRITE calls: request params, and the three response envelopes ----
//
// `docs/roadmap.md` recorded these as the remaining hole: the four write
// methods' request params and the responses of `agent.send_keys`,
// `agent.prompt` and `agent.wait` were hand-written object literals with
// nothing comparing them to anything. Their shapes had been MEASURED against
// herdr 0.8.0 and reflected in `tests/actions.test.ts`'s fakes — but a fake is
// paddock's own belief, so it agrees with the code by construction and would
// go on agreeing after herdr renamed the field underneath both.
//
// This is the file that makes the "a herdr rename is a build error" claim in
// docs/gotchas.md true for the write half, not just the read half. The read
// half was closed first because it had already broken in production: `actions.ts`
// read `result.text` for the whole of v2 where herdr sends `result.read.text`,
// and the symptom was an empty pane plus tap-to-answer degrading silently to
// the free-text box.

const DECLARED_SEND_KEYS_PARAM_FLAGS = {
  target: true,
  keys: true,
} satisfies Record<keyof HerdrAgentSendKeysParams, true>;

const DECLARED_PROMPT_PARAM_FLAGS = {
  target: true,
  text: true,
  wait: true,
} satisfies Record<keyof HerdrAgentPromptParams, true>;

const DECLARED_WAIT_PARAM_FLAGS = {
  target: true,
  timeout_ms: true,
  until: true,
} satisfies Record<keyof HerdrAgentWaitParams, true>;

const DECLARED_READ_PARAM_FLAGS = {
  target: true,
  source: true,
  lines: true,
  format: true,
  strip_ansi: true,
} satisfies Record<keyof HerdrAgentReadParams, true>;

const PARAM_CASES = [
  ["AgentSendKeysParams", DECLARED_SEND_KEYS_PARAM_FLAGS],
  ["AgentPromptParams", DECLARED_PROMPT_PARAM_FLAGS],
  ["AgentWaitParams", DECLARED_WAIT_PARAM_FLAGS],
  ["AgentReadParams", DECLARED_READ_PARAM_FLAGS],
] as const;

test.skipIf(!HAVE_HERDR)("the write calls' request params have not drifted", async () => {
  const schema = await liveSchema();
  for (const [name, flags] of PARAM_CASES) {
    const live = schema.schemas.request.$defs[name];
    expect(live, `${name} is still a named $def`).toBeDefined();
    // No ignore list on purpose: a parameter paddock does not send is still a
    // parameter it must know exists, because the choice not to send it is only
    // a decision while it is visible. A NEW upstream parameter failing here is
    // the point.
    expectNoDrift(Object.keys(live.properties), Object.keys(flags), []);
  }
});

test.skipIf(!HAVE_HERDR)("agent.read still REQUIRES source, which every paddock call site sends", async () => {
  // Not a shape check but a contract one: `source` is required upstream, and
  // both `readOutput` and `readPromptScreen` pass it. If herdr ever made it
  // optional, or paddock ever dropped it, one of those two facts moves.
  const schema = await liveSchema();
  expect(schema.schemas.request.$defs.AgentReadParams.required).toContain("source");
  expect(schema.schemas.request.$defs.AgentReadParams.required).toContain("target");
});

const DECLARED_OK_FLAGS = { type: true } satisfies Record<keyof HerdrOk, true>;

const DECLARED_PROMPTED_FLAGS = {
  type: true,
  agent: true,
} satisfies Record<keyof HerdrAgentPrompted, true>;

const DECLARED_WAITED_FLAGS = {
  type: true,
  agent: true,
} satisfies Record<keyof HerdrAgentWaited, true>;

const ENVELOPE_CASES = [
  ["ok", DECLARED_OK_FLAGS, false],
  ["agent_prompted", DECLARED_PROMPTED_FLAGS, true],
  ["agent_info", DECLARED_WAITED_FLAGS, true],
] as const;

test.skipIf(!HAVE_HERDR)("the write calls' response envelopes have not drifted", async () => {
  const schema = await liveSchema();
  const variants: any[] = schema.schemas.success_response.$defs.ResponseResult.oneOf;
  for (const [discriminator, flags, carriesAgent] of ENVELOPE_CASES) {
    const variant = variants.find((v) => v.properties?.type?.const === discriminator);
    expect(variant, `the ${discriminator} variant is still there`).toBeDefined();
    if (carriesAgent) {
      // The `agent` these carry is an AgentInfo, which is what makes them worth
      // typing: `agent.wait` is how paddock learns a blocked agent moved on.
      expect(variant.properties.agent.$ref).toBe(
        "#/schemas/success_response/$defs/AgentInfo",
      );
    }
    expectNoDrift(Object.keys(variant.properties), Object.keys(flags), []);
  }
});
