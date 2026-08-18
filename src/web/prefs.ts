/**
 * The single owner of localStorage for per-device preferences.
 *
 * install.ts:48 records that Safari private mode throws OUTRIGHT on access,
 * not merely on write. Handled once here rather than in every component that
 * wants a preference — an uncaught throw would take the view down with it.
 */
export type ThemePref = "system" | "light" | "dark";
export type RatePref = "live" | "balanced" | "frugal";

/** Named points, not a milliseconds field: a free numeric input invites a
 *  value that hammers herdr, and the real decision is whether the connection
 *  is metered rather than which precise interval is optimal. */
export const RATE_MS: Record<RatePref, number> = { live: 250, balanced: 1_000, frugal: 3_000 };

export interface Prefs {
  theme: ThemePref;
  rate: RatePref;
  wrap: boolean;
  fontPx: number;
}

/**
 * `wrap` defaults to `true`, not `false`. Measured across five live agents:
 * of the lines too long for a phone, 57% are STRUCTURED — box drawing, or
 * table rows whose columns carry meaning positionally — and 43% are prose or
 * code that reflows perfectly. Wrapping is the default because reading is the
 * common case, and a folded table is recoverable with one tap whereas
 * scrolling every prose line is a permanent tax. This is the rationale
 * `AgentTerminal.tsx`'s own former `readWrap()` carried; it must survive the
 * move here; see `readPrefs()` below for how "never stored" (default `true`)
 * is kept distinct from "explicitly turned off" (`"0"`, default `false`).
 */
const DEFAULTS: Prefs = { theme: "system", rate: "live", wrap: true, fontPx: 13 };

/** `wrap` is kept verbatim from AgentTerminal's own `WRAP_KEY` so no
 *  operator's current setting resets. All other keys are namespaced the
 *  same way for consistency. */
const KEYS = {
  theme: "paddock.theme",
  rate: "paddock.rate",
  wrap: "paddock.term.wrap",
  fontPx: "paddock.term.fontpx",
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
  return {
    theme: theme === "light" || theme === "dark" ? theme : DEFAULTS.theme,
    rate: rate === "balanced" || rate === "frugal" ? rate : DEFAULTS.rate,
    wrap: wrapRaw === null ? DEFAULTS.wrap : wrapRaw === "1",
    fontPx: Number.isFinite(font) && font >= 10 && font <= 22 ? font : DEFAULTS.fontPx,
  };
}

export function writePref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
  try {
    localStorage.setItem(KEYS[k], k === "wrap" ? (v ? "1" : "0") : String(v));
  } catch {
    // Safari private mode: the preference simply does not persist, which is
    // preferable to an uncaught throw taking the whole settings view down.
  }
}
