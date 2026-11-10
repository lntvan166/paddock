/**
 * Where an agent comes from. Terminal herdr and the herdr-core app are two
 * backends behind one payload contract, and their id spaces must never meet.
 */
export type Origin = "herdr" | "core";

/**
 * Prefix on every core agent id. URL-safe, and it can never start a terminal
 * herdr id (`w1:p1`), so a core id and a herdr id are never equal even when
 * the raw ids or the agent names coincide.
 */
export const CORE_PREFIX = "hc.";

/** `"t7"` becomes `"hc.t7"`. */
export function coreId(raw: string): string {
  return CORE_PREFIX + raw;
}

export function isCoreId(id: string): boolean {
  return id.startsWith(CORE_PREFIX);
}

/** The core's own id back out of a paddock id. Throws on a herdr id. */
export function rawCoreId(id: string): string {
  if (!isCoreId(id)) throw new Error(`not a core id: ${id}`);
  return id.slice(CORE_PREFIX.length);
}
