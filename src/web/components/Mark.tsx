/**
 * paddock's mark, for use inside the app.
 *
 * The glyph geometry is copied verbatim from `assets/logo.svg`, which is the
 * master every PNG in `public/` is built from. `tests/mark.test.ts` fails if
 * the two ever diverge — `scripts/build-icons.sh` already guards the SVG pair,
 * and this is the same guard extended to the third copy that has to live in
 * TypeScript because of the colour change below.
 *
 * What changes here, and why:
 *
 *  - **No ground tile.** `logo.svg` paints herdr's warm grey behind the glyph
 *    because it is an app-icon tile that has to sit on an unknown home screen.
 *    Inside paddock the ground is already `--bg`, and a light rectangle in the
 *    header would read as a sticker pasted onto the page.
 *  - **`currentColor` for the figure**, rather than herdr's charcoal, so the
 *    mark follows the theme. On the dark ground it renders near-white and on
 *    light it renders near-black, with no second asset and no media query.
 *  - **`--warn` for the lit segment**, which is the same amber the UI already
 *    uses for a blocked agent. In `logo.svg` that bar is coral, chosen to sit
 *    beside herdr's palette; here it can mean exactly what the colour already
 *    means everywhere else in the app.
 *
 * `logo.svg`'s own comment anticipates this swap and names these tokens,
 * having judged family resemblance with herdr worth more than matching the
 * app's ground — a trade that is right for the installed icon and wrong for a
 * 16px mark in the header.
 *
 * Decorative: the adjacent text already says "paddock", so the SVG is hidden
 * from assistive tech rather than repeating the name.
 */
export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flexShrink: 0 }}
    >
      <g fill="none" stroke="currentColor" strokeWidth="34" strokeLinecap="round">
        <path d="M256 264C256 176 228 128 190 136c-38 8-44 60-8 74" />
        <path d="M256 264c0-88 28-136 66-128 38 8 44 60 8 74" />
      </g>
      <g fill="currentColor">
        <rect x="112" y="296" width="288" height="32" rx="16" />
        <rect x="112" y="362" width="104" height="32" rx="16" />
        <rect x="296" y="362" width="104" height="32" rx="16" />
      </g>
      <rect x="230" y="362" width="52" height="32" rx="16" fill="var(--warn)" />
    </svg>
  );
}
