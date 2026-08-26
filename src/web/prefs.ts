/**
 * The single owner of localStorage for per-device preferences.
 *
 * install.ts:48 records that Safari private mode throws OUTRIGHT on access,
 * not merely on write. Handled once here rather than in every component that
 * wants a preference — an uncaught throw would take the view down with it.
 */
/**
 * Every theme the picker offers, in the order it offers them.
 *
 * The ORDER is the UI order: paddock's own three first, then the named
 * palettes. `system` is first because it is the default and the only entry
 * that follows the operating system — every named theme pins itself, which is
 * the accepted cost of a flat list (see the design doc, §2).
 *
 * This table and the `:root[data-theme=…]` blocks in styles.css are two
 * sources of truth, and `tests/themes.test.ts` asserts they agree: an id here
 * with no block would render unstyled, and a block with no id here would be
 * unreachable from the picker. Same "guards the guard" pattern
 * `tests/ui-icons.test.tsx` uses for its glyph list.
 *
 * `system` and `light` deliberately have NO block of their own — `light` IS
 * the bare `:root` palette and `system` sets no attribute at all. `dark`
 * already had one before any of this. The consistency test knows those by
 * name; every other id must have a block.
 */
export const THEMES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "dracula", label: "Dracula" },
  { id: "gruvbox-dark", label: "Gruvbox Dark" },
  { id: "gruvbox-light", label: "Gruvbox Light" },
  { id: "nord", label: "Nord" },
] as const;

export type ThemePref = (typeof THEMES)[number]["id"];
export type RatePref = "live" | "balanced" | "frugal";

/**
 * How much of the terminal's key pad is on screen.
 *
 * - `full`     — both rows: ↑ ↓ ⏎ Enter, then Esc ← → Tab Space.
 * - `compact`  — the primary row only. Esc/←/→/Tab/Space are the
 *                rarely-reached half, and on a phone they are ~3rem of a
 *                screen whose job is showing a transcript.
 * - `hidden`   — no pad. 106px of a 390x844 phone, measured, handed back to
 *                the transcript.
 *
 * `hidden` is the default, and the reason is that tapping a parsed option does
 * NOT need the pad. `AgentTerminal`'s option buttons call `answerWithKey` with
 * the agent's OWN digit — one tap, and per that code's own note "committing one
 * cannot be off by one the way arrowing to it can". The pad exists for the
 * prompt shapes the parser refuses, where no buttons render at all.
 *
 * The invariant this file used to state as "↑ ↓ ⏎ Enter stay put in every
 * state" is intact in the form that mattered: nothing ever moves under a thumb,
 * because the automatic transition only ever REVEALS. See `keypadAuto`.
 */
export type KeypadPref = "full" | "compact" | "hidden";

/** Named points, not a milliseconds field: a free numeric input invites a
 *  value that hammers herdr, and the real decision is whether the connection
 *  is metered rather than which precise interval is optimal. */
export const RATE_MS: Record<RatePref, number> = { live: 250, balanced: 1_000, frugal: 3_000 };

export interface Prefs {
  theme: ThemePref;
  rate: RatePref;
  wrap: boolean;
  /**
   * `null` means "no explicit preference" — NOT a number.
   *
   * `styles.css` sizes `.term-pane` by COLUMNS VISIBLE:
   * `font-size: var(--term-font-px, clamp(0.62rem, 2.3vw, 0.78rem))`, and the
   * comment above that rule records that the metric was measured and the
   * floor corrected once already. The clamp is only ever reached when the
   * custom property is unset, so `AgentTerminal` must write the property only
   * when this is a number. Consumers: treat `null` as "write nothing".
   */
  fontPx: number | null;
  keypad: KeypadPref;
  /**
   * Whether a blocked agent may open a collapsed pad by itself.
   *
   * Expand-only, never the reverse: opening reveals a key the operator was
   * about to want, while closing one mid-tap is the failure the always-present
   * rule exists to prevent. Stored so the operator can decline the behaviour
   * entirely, which is what was asked for.
   */
  keypadAuto: boolean;
}

/**
 * `wrap` defaults to `true`, not `false`. Measured across five live agents:
 * of the lines too long for a phone, 57% are STRUCTURED — box drawing, or
 * table rows whose columns carry meaning positionally — and 43% are prose or
 * code that reflows perfectly. Wrapping is the default because reading is the
 * common case, and a folded table is recoverable whereas scrolling every prose
 * line is a permanent tax.
 *
 * "with one tap" was true when the terminal's own control bar carried a second
 * toggle for this key. It does not any more — Settings' Terminal card is the
 * one place it is set — so recovery is a trip rather than a tap. The default
 * still holds for the same reason; the asymmetry it rests on is just smaller
 * than it was. This is the rationale
 * `AgentTerminal.tsx`'s own former `readWrap()` carried; it must survive the
 * move here; see `readPrefs()` below for how "never stored" (default `true`)
 * is kept distinct from "explicitly turned off" (`"0"`, default `false`).
 *
 * `fontPx` defaults to `null` for the same reason `wrap` defaults to `true`
 * and not `false`: a default that is indistinguishable from an explicit
 * choice silently overrides behaviour the operator never asked to change.
 * The previous numeric default (13) was written to `--term-font-px` on every
 * render for every operator, so the responsive clamp above was dead code —
 * and 13px is above the clamp's ~12.5px ceiling and far above its ~9.9px
 * value on a 390px viewport, dropping visible columns from roughly 62 to 48
 * on a phone. The clamp stays in charge until someone chooses a size.
 */
const DEFAULTS: Prefs = {
  theme: "system", rate: "live", wrap: true, fontPx: null,
  // HIDDEN by default, and this comment used to say "visible by default, for
  // the same reason `wrap` is" long after the value stopped agreeing with it.
  // The pad is 106px of a 390x844 phone and a parsed prompt answers in one tap
  // on a real option button, so it is not the primary path on the screen it
  // used to charge a quarter of.
  //
  // WHAT THIS DEFAULT MUST NOT DECIDE: whether an operator can act. The shell's
  // reply box submits through the route (`submit: true`), so a first run with
  // this pref untouched can still RUN a command — which for a while it could
  // not, because the pad's Enter was the only one in the app.
  keypad: "hidden",
  // Auto-reveal on a blocked agent whose prompt the parser could not read, so
  // the arrows appear exactly when they are the only way in. Never persisted:
  // that is the agent's doing, not a choice (see `AgentTerminal`).
  keypadAuto: true,
};

/** `wrap` is kept verbatim from AgentTerminal's own `WRAP_KEY` so no
 *  operator's current setting resets. All other keys are namespaced the
 *  same way for consistency. */
const KEYS = {
  theme: "paddock.theme",
  rate: "paddock.rate",
  wrap: "paddock.term.wrap",
  fontPx: "paddock.term.fontpx",
  keypad: "paddock.term.keypad",
  keypadAuto: "paddock.term.keypad.auto",
} as const;

function raw(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    // Safari private mode (and some enterprise storage policies) throw on
    // mere property access, not only on write. Falling back to "nothing
    // stored" degrades to defaults instead of crashing the settings view.
    return null;
  }
}

export function readPrefs(): Prefs {
  const theme = raw(KEYS.theme);
  const rate = raw(KEYS.rate);
  const font = Number(raw(KEYS.fontPx));
  // `null` (never stored, or `raw()`'s catch path on throwing storage) must
  // fall back to the default (`true`) rather than be treated the same as an
  // explicit `"0"`. `raw(KEYS.wrap) === "1"` alone would collapse both
  // "never touched" and "explicitly turned off" into the same `false`
  // answer, silently flipping the default for every operator who never
  // opened the setting.
  const wrapRaw = raw(KEYS.wrap);
  const keypad = raw(KEYS.keypad);
  // Same "never stored" care as `wrap`: `=== "1"` alone would read an operator
  // who has never opened the setting as one who switched it off.
  const autoRaw = raw(KEYS.keypadAuto);
  return {
    // Checked against the registry rather than a hardcoded pair. A value left
    // by a build that offered a theme since removed must fall back to the
    // default, not reach `data-theme` and match no block.
    theme: THEMES.some((t) => t.id === theme) ? (theme as ThemePref) : DEFAULTS.theme,
    rate: rate === "balanced" || rate === "frugal" ? rate : DEFAULTS.rate,
    wrap: wrapRaw === null ? DEFAULTS.wrap : wrapRaw === "1",
    fontPx: Number.isFinite(font) && font >= 10 && font <= 22 ? font : DEFAULTS.fontPx,
    // An unrecognised or absent value falls back to the default. A value
    // stored by a build that only knew "full" | "compact" is still honoured —
    // an operator who chose to see the pad keeps seeing it.
    keypad: keypad === "compact" || keypad === "full" || keypad === "hidden"
      ? keypad
      : DEFAULTS.keypad,
    keypadAuto: autoRaw === null ? DEFAULTS.keypadAuto : autoRaw === "1",
  };
}

export function writePref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
  try {
    // `null` REMOVES the key rather than storing the string "null". "Back to
    // automatic" has to leave storage in exactly the state "never touched"
    // leaves it, or the clamp is only in charge until the field is opened
    // once. Only `fontPx` is nullable today; the check is on the value, not
    // the key, so a future nullable pref inherits the behaviour.
    if (v === null) { localStorage.removeItem(KEYS[k]); return; }
    // Keyed on the value's TYPE, not on one pref's name. Written as
    // `k === "wrap"`, a second boolean pref was stored as "true" and read back
    // by `=== "1"` as false — off the moment it was switched on.
    localStorage.setItem(KEYS[k], typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  } catch {
    // Safari private mode: the preference simply does not persist, which is
    // preferable to an uncaught throw taking the whole settings view down.
  }
}

/**
 * The attribute value `styles.css`'s `:root[data-theme="dark"]` (and the
 * `:not([data-theme="light"])` escape from the system-dark media query)
 * listens for.
 *
 * `null` for "system" rather than the literal string, because "system" means
 * "defer to `prefers-color-scheme`", which is exactly what having NO
 * attribute already does. Exported and tested directly rather than asserting
 * on `dataset.theme` after setting it, which would only prove the DOM
 * reflects an attribute back — not that paddock chose the right one.
 *
 * Lives here (not in `App.tsx`, where it was first written) rather than in
 * either of its two callers: `App.tsx`'s mount effect and `Settings.tsx`'s
 * live-apply-on-change both need it, and `App.tsx` already imports
 * `Settings.tsx` — a second import in the other direction would be a
 * circular module dependency for no reason beyond convenience.
 */
export function themeAttr(pref: ThemePref): Exclude<ThemePref, "system"> | null {
  return pref === "system" ? null : pref;
}
