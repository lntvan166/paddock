/**
 * Sixteen hand-written glyphs: one per settings card, the three in the
 * bottom `TabBar` — Agents, Spaces and Settings — and the terminal's own
 * four, `KeyboardIcon`, `BackspaceIcon`, `ImageIcon` and `FlashIcon`.
 *
 * Spaces and Settings used to be the two controls in `HostHeader`'s top-right
 * corner; they now label tabs instead, and `AgentsIcon` joined them.
 *
 * Icon libraries are tens of kilobytes of tree-shaken JavaScript for what is a
 * few hundred bytes of path data here, on a project whose bundle is deliberately
 * ONE chunk because at high RTT an extra round trip costs more than the bytes it
 * saves. These twelve are hand-written instead.
 *
 * `currentColor` throughout, so a glyph is never a colour that has to be
 * redefined per theme, and `aria-hidden` throughout, because every one of them
 * sits beside a text title that already says what it means.
 */
function Svg({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      width="24" height="24" viewBox="0 0 24 24"
      fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

type IconProps = { className?: string };

export function MonitorIcon({ className }: IconProps) {
  return <Svg className={className}><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>;
}

export function ActivityIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M3 12h4l3 8 4-16 3 8h4" /></Svg>;
}

export function TerminalIcon({ className }: IconProps) {
  return <Svg className={className}><rect x="2" y="3" width="20" height="18" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></Svg>;
}

export function BellIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16z" /><path d="M10 21h4" /></Svg>;
}

export function SendIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M21 3L10 14M21 3l-7 18-4-7-7-4z" /></Svg>;
}

/** Quick actions. A bolt: the shape every interface uses for "the fast way",
 *  and distinct at 16px from the keyboard beside it. */
export function FlashIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z" /></Svg>;
}

/** The attach control, left of the reply field. A frame with a sun and a hill:
 *  the same shape every messaging app uses for "a picture goes here". */
export function ImageIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </Svg>
  );
}

export function LinkIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M9 15l6-6" /><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1M13 18l-1 1a4 4 0 0 1-6-6l1-1" /></Svg>;
}

export function RefreshIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></Svg>;
}

export function PlugIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M9 2v6M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v5" /></Svg>;
}

/**
 * The Spaces entry point in the host header.
 *
 * Drawn rather than written. This button carried `▦` (U+25A6 SQUARE WITH
 * ORTHOGONAL CROSSHATCH FILL), a codepoint with patchy coverage in mobile
 * system fonts — and `AgentTerminal.tsx` already records what that costs from
 * the `␣` it spells out as "Space": a symbol that renders as a tofu box is a
 * button whose label is a rendering failure. This one is the ONLY route into
 * `#/spaces`, so it is the worst place in the app to gamble on font coverage.
 *
 * Four cells rather than a terminal outline: it has to be distinguishable from
 * `TerminalIcon`, and what the screen shows is a grid of spaces, not a shell.
 */
/** Back. A DRAWN chevron, not `‹` (U+2039).
 *
 *  The third codepoint this project has replaced for the same reason as `▦`
 *  and `⚙`: a text glyph's weight and side bearing vary by platform, where a
 *  stroked path does not. Reported as "the back arrow is thin and has space on
 *  its left" — the thinness is a 600-weight text glyph against these 2px
 *  strokes, and the space is U+2039's own left bearing. */
export function BackIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M15 5l-7 7 7 7" /></Svg>;
}

/** The agent list. Three rows with a leading marker each — the dashboard's own
 *  shape, which is what the tab opens. */
export function AgentsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1.4" /><circle cx="4.5" cy="12" r="1.4" /><circle cx="4.5" cy="18" r="1.4" />
    </Svg>
  );
}

export function SpacesIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </Svg>
  );
}

/**
 * The Settings entry point in the host header.
 *
 * Drawn, for the reason `SpacesIcon` above is drawn, and grouped with it by
 * §16.5 — two controls in the same cluster must not look like two systems.
 *
 * This was a gear, and it was not one: a circle at the centre with six
 * DETACHED ticks in the annulus and no outer rim, which is the standard
 * brightness glyph. The comment it replaced records how that happened — it
 * worried that more teeth would close the gaps into a ring, and removed the
 * rim to keep them distinct. That fixed the density and left the metaphor
 * behind.
 *
 * Sliders rather than restoring the rim, because the header renders at 18px:
 * a gear at that size has a 3.9px annulus holding 1.1px teeth, and rendered it
 * collapses into a blob. These two tracks have no detail inside a ring at all,
 * and their smallest feature is a 3.2px knob.
 */
export function SettingsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2.1" />
      <circle cx="10" cy="17" r="2.1" />
    </Svg>
  );
}

/**
 * The keypad toggle in the terminal's control bar.
 *
 * A key cap outline with three dots and a space bar — enough to read as a
 * keyboard at the 13px the bar renders, and nothing inside it small enough to
 * collapse there.
 */
export function KeyboardIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
    </Svg>
  );
}

/**
 * Backspace — delete ONE character. Clearing a line is `^U`, behind the Ctrl
 * latch, and nothing on the pad claims to do it in one tap.
 *
 * FILLED, against every other glyph in this file, and the exception is the
 * point rather than an inconsistency.
 *
 * Three drafts. The first was `⌫` (U+232B) — a raw codepoint, which this file
 * already records losing twice: `▦` and `␣` both rendered as tofu boxes on
 * mobile and were replaced. The second drew it as an outline with an × inside
 * and turned to mud at 18px — the identical failure `SettingsIcon` above
 * documents, where a 3.9px annulus held 1.1px teeth.
 *
 * What survives is inverting figure and ground: fill the shape and knock the ×
 * out as negative space. Nothing thin is left to collapse — the smallest
 * feature becomes a ~2.4px GAP, and a gap holds at sizes where a hairline does
 * not. Rendered beside the arrow keys it also reads as a different KIND of
 * key, which is correct: backspace is not a movement.
 *
 * `stroke="none"` is load-bearing. The `Svg` wrapper sets
 * `stroke="currentColor"`, so a filled path that does not opt out is drawn
 * twice — filled AND outlined — which at this size is a smudge.
 */
export function BackspaceIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path
        fill="currentColor"
        stroke="none"
        fillRule="evenodd"
        d="M8.6 3.5h11.6c1.2 0 2.3 1 2.3 2.3v12.4c0 1.3-1 2.3-2.3 2.3H8.6c-.7 0-1.4-.3-1.8-.9L1.3 13c-.5-.6-.5-1.4 0-2l5.5-6.6c.4-.6 1.1-.9 1.8-.9zm8.6 5.1c-.5-.5-1.2-.5-1.7 0l-1.7 1.7-1.7-1.7c-.5-.5-1.2-.5-1.7 0s-.5 1.2 0 1.7l1.7 1.7-1.7 1.7c-.5.5-.5 1.2 0 1.7s1.2.5 1.7 0l1.7-1.7 1.7 1.7c.5.5 1.2.5 1.7 0s.5-1.2 0-1.7L15.2 12l1.7-1.7c.5-.5.5-1.2 0-1.7z"
      />
    </Svg>
  );
}
