import { claudeAdapter } from "@server/journal/claude";
import type { HerdrAgentSession } from "@shared/herdr-api";
import type { JournalAdapter } from "@server/journal/types";

/**
 * The SINGLE decision site for "does this agent have a readable history".
 *
 * Adding a harness is one entry here plus its adapter module — never a new
 * branch in the route and never a condition in the client.
 */
const ADAPTERS: readonly JournalAdapter[] = [claudeAdapter];

export function adapterFor(session: HerdrAgentSession | null | undefined): JournalAdapter | null {
  if (!session) return null;
  // Only an id can become a path. Any other `kind` is a value this code has no
  // way to resolve, and guessing is how a lookup becomes a traversal.
  if (session.kind !== "id") return null;
  return ADAPTERS.find((a) => a.name === session.agent) ?? null;
}

export function hasAdapter(session: HerdrAgentSession | null | undefined): boolean {
  return adapterFor(session) !== null;
}
