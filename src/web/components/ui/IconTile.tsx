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
    // Anthropic's mark, drawn on a 24x24 viewBox to match `icons.tsx`.
    path: "M4.71 15.14 9.4 12.5l.08-.23-.08-.13H9.17l-.8-.05-2.74-.07-2.37-.1-2.3-.12-.58-.12L0 10.97l.06-.36.49-.33.7.06 1.54.11 2.32.16 1.68.1 2.49.26h.4l.05-.16-.13-.1-.11-.1-2.5-1.7-2.72-1.8-1.42-1.03-.77-.52-.39-.49-.17-1.07.7-.77.93.07.24.06.95.73 2.03 1.57 2.65 1.95.39.32.15-.11.02-.08-.18-.29-1.44-2.6-1.54-2.65-.68-1.1-.18-.66a3.2 3.2 0 0 1-.11-.77l.79-1.08L6.94 0l1.06.14.44.39.66 1.5 1.06 2.37L11.8 6.6l.48.96.26.89.1.27h.17V8.56l.14-1.86.26-2.29.25-2.94.09-.83.41-1L15.78.2l.64.3.53.76-.07.49-.32 2.06-.62 3.24-.4 2.17h.23l.27-.27 1.1-1.45 1.83-2.3.81-.9.95-1.01.6-.48h1.15l.85 1.26-.38 1.3-1.19 1.51-.99 1.28-1.42 1.91-.88 1.53.08.12.21-.02 3.19-.68 1.72-.31 2.05-.35.93.43.1.44-.37.9-2.22.55-2.6.52-3.87.92-.05.03.06.07 1.74.17.75.04h1.83l3.4.25.9.59.53.71-.09.54-1.37.7-1.84-.44-4.3-1.02-1.48-.37h-.2v.12l1.23 1.2 2.26 2.04 2.83 2.63.14.65-.36.51-.38-.05-2.48-1.86-.96-.84-2.16-1.82h-.14v.19l.5.73 2.63 3.95.13 1.21-.19.4-.68.24-.75-.14-1.54-2.16-1.59-2.44-1.29-2.19-.15.09-.76 8.1-.35.42-.82.31-.68-.52-.36-.84.36-1.65.43-2.15.35-1.71.32-2.12.19-.7-.01-.05-.16.02-1.6 2.2-2.43 3.29-1.93 2.06-.46.19-.8-.42.07-.74.45-.66 2.69-3.42 1.62-2.12 1.05-1.22-.01-.18h-.06L6.3 18.56l-1.98.26-.85-.08-.21-.4.17-.32 1.4-.96 2.1-1.5-.22-.42Z",
  },
} as const;

export function markFor(harness: string): { path: string } | null {
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
      style={{ background: `var(--tile-${hueFor(harness)})` }}
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
