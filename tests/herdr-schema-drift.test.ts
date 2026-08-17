import { expect, test } from "bun:test";
import type { HerdrAgentRaw } from "@shared/herdr-api";

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

test("HerdrAgentRaw has not drifted from the installed herdr's AgentInfo schema", async () => {
  const proc = Bun.spawn(["herdr", "api", "schema", "--json"], { stdout: "pipe" });
  const schema = JSON.parse(await new Response(proc.stdout).text());
  const liveProperties: string[] = Object.keys(
    schema.schemas.success_response.$defs.AgentInfo.properties,
  );

  // Catches a rename or removal: every field HerdrAgentRaw declares must
  // still be a real property on the live AgentInfo.
  for (const field of DECLARED_FIELDS) {
    expect(liveProperties).toContain(field);
  }

  // Catches a new upstream field paddock is silently ignoring: every live
  // property must be either modeled or explicitly on the ignore list.
  const known = new Set<string>([...DECLARED_FIELDS, ...IGNORED_FIELDS]);
  const unaccountedFor = liveProperties.filter((property) => !known.has(property));
  expect(unaccountedFor).toEqual([]);
});
