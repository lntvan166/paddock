import { useEffect, useState } from "react";

/**
 * The one width at which paddock stops being a phone column.
 *
 * At and above it, opening an agent keeps the agent list beside the terminal
 * (an icon rail, the list, the terminal) instead of replacing it. A WIDTH
 * media query, which is what CLAUDE.md allows for layout — never a device or
 * user-agent check. It is evaluated in JS rather than CSS alone for one
 * reason: below it the list must not be MOUNTED behind the terminal, or a
 * phone would keep the dashboard's clock and its blocked cards' prompt reads
 * running underneath a screen that hides them.
 *
 * Kept in step with the `@media (min-width: 70rem)` block in styles.css.
 */
export const WIDE_QUERY = "(min-width: 70rem)";

export function useWide(): boolean {
  const get = () => typeof matchMedia === "function" && matchMedia(WIDE_QUERY).matches;
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(WIDE_QUERY);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}
