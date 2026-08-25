/**
 * Ten hand-written glyphs: one per settings card, plus the two header controls
 * in `HostHeader` — Spaces and Settings.
 *
 * Icon libraries are tens of kilobytes of tree-shaken JavaScript for what is a
 * few hundred bytes of path data here, on a project whose bundle is deliberately
 * ONE chunk because at high RTT an extra round trip costs more than the bytes it
 * saves. These ten are hand-written instead.
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
