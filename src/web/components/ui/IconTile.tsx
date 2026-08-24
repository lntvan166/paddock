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
 * The brand a harness name refers to, or null.
 *
 * Lower-cased and reduced to its first segment, because herdr reports the
 * harness as its own name and `claude-code` is the same product as `claude`. A
 * table keyed on the exact string would miss the variant and fall back to
 * initials for an agent whose mark we actually have.
 */
export function brandKey(harness: string): keyof typeof MARKS | null {
  const head = harness.toLowerCase().split(/[-_ ]+/)[0] ?? "";
  return head in MARKS ? (head as keyof typeof MARKS) : null;
}

/**
 * The mark for a harness, or null when there is none.
 *
 * ONE mark, for the one harness that actually runs here. Marks for harnesses
 * nobody runs would be path data committed on speculation, and every one of
 * them is a third-party trademark — so they get added when something needs
 * them, not in advance.
 *
 * Null rather than a placeholder glyph: a wrong mark is worse than initials,
 * because it claims an identity the agent does not have.
 *
 * Path data from Simple Icons (CC0). Displaying which agent is running is
 * nominative use — this is not a claim of affiliation.
 */
const MARKS = {
  claude: {
    /**
     * Anthropic's mark, on the 24x24 viewBox `icons.tsx` uses.
     *
     * From lobehub/lobe-icons, which is MIT — a cleaner provenance than
     * redrawing it or lifting CC0 path data and reasoning about the trademark
     * separately. Extracted from the published SVG rather than retyped: a
     * hand-copied path fails as a smudge that no test can catch.
     */
    path: "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z",
    /** The brand's own colour, so a claude tile is recognisable before the
     *  mark inside it is. Not the hash hue — a brand we KNOW should not be
     *  assigned a colour by accident. */
    tile: "--tile-claude",
  },
} as const;

/** Derived from MARKS rather than restated, so adding a field to an entry
 *  cannot leave this signature behind. */
export type Mark = (typeof MARKS)[keyof typeof MARKS];

export function markFor(harness: string): Mark | null {
  const key = brandKey(harness);
  return key === null ? null : MARKS[key];
}

/**
 * A round tile carrying an agent's harness identity.
 *
 * A brand mark where paddock has one, initials otherwise. The initials path is
 * not a stopgap — it is what keeps a harness paddock has never seen
 * identifiable instead of rendering a blank circle, and herdr keeps growing
 * harnesses.
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
  const mark = markFor(harness);
  return (
    <span
      className="tile"
      data-shape="round"
      data-size={size}
      aria-label={harness}
      style={{ background: `var(${mark?.tile ?? `--tile-${hueFor(harness)}`})` }}
    >
      {mark === null
        ? <span aria-hidden="true" className="tile-initials">{initialsFor(harness)}</span>
        : (
          <svg
            aria-hidden="true"
            focusable="false"
            className="tile-mark"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d={mark.path} />
          </svg>
        )}
      {badge ? <span className="tile-badge">{badge}</span> : null}
    </span>
  );
}
