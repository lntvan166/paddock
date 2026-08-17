/**
 * Attribute for the container wrapping the host header and sections. Drives
 * the dimming rule in styles.css. The banner itself is never wrapped in this
 * — the message announcing staleness must stay at full opacity, only the
 * data below it dims.
 */
export function staleAttrs(stale: boolean): { "data-stale"?: "true" } {
  return stale ? { "data-stale": "true" } : {};
}
