/** How many hues the tile palette holds. Kept in one place so `hueFor` and
 *  the stylesheet cannot disagree about the range. */
const HUES = 6;

/**
 * Initials for a harness name.
 *
 * One letter per segment for a compound name (`claude-code` → `CC`), the first
 * two letters otherwise (`claude` → `CL`). Never empty: an unknown harness
 * must stay identifiable rather than rendering a blank circle, which is the
 * case that actually shows up as herdr grows harnesses paddock has not heard
 * of.
 */
export function initialsFor(harness: string): string {
  const segments = harness.split(/[-_ ]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return "?";
  if (segments.length === 1) return segments[0]!.slice(0, 2).toUpperCase();
  return segments.slice(0, 2).map((s) => s[0]!).join("").toUpperCase();
}

/**
 * A stable hue index for a harness.
 *
 * Derived rather than tabulated on purpose: a hardcoded table silently omits
 * every harness nobody thought of, and those are exactly the ones that need a
 * distinguishable tile. Any change to this function reshuffles every tile's
 * colour, which is cosmetic but visible — it is not a hash anyone depends on
 * across versions.
 */
export function hueFor(harness: string): number {
  let h = 0;
  for (let i = 0; i < harness.length; i++) h = (h * 31 + harness.charCodeAt(i)) | 0;
  return Math.abs(h) % HUES;
}

/**
 * A round tile carrying an agent's harness identity.
 *
 * Initials rather than brand logos, deliberately: real marks would mean
 * committing third-party path data and using another project's trademark in an
 * unaffiliated tool. Initials also degrade gracefully — a harness paddock has
 * never seen gets a real tile instead of a placeholder.
 *
 * The tile carries its OWN background and foreground rather than inheriting the
 * page surface, so one definition reads on both themes.
 */
export function IconTile({
  harness, size = "sm", badge,
}: {
  harness: string;
  size?: "sm" | "md";
  badge?: React.ReactNode;
}) {
  return (
    <span
      className="tile"
      data-shape="round"
      data-size={size}
      aria-label={harness}
      style={{ background: `var(--tile-${hueFor(harness)})` }}
    >
      <span aria-hidden="true" className="tile-initials">{initialsFor(harness)}</span>
      {badge ? <span className="tile-badge">{badge}</span> : null}
    </span>
  );
}
