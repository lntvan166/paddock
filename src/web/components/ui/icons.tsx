/**
 * Nine hand-written glyphs: one per settings card, plus the Spaces entry point
 * in `HostHeader`.
 *
 * Icon libraries are tens of kilobytes of tree-shaken JavaScript for what is a
 * few hundred bytes of path data here, on a project whose bundle is deliberately
 * ONE chunk because at high RTT an extra round trip costs more than the bytes it
 * saves. These nine are hand-written instead.
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
