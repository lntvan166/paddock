import { AgentsIcon, SettingsIcon, SpacesIcon } from "@web/components/ui/icons";

/**
 * The three top-level destinations, at the bottom of the screen.
 *
 * paddock has exactly three — Agents, Spaces, Settings — and used to reach two
 * of them through 44px icon buttons in the TOP-RIGHT corner of `HostHeader`:
 * the least reachable point on a phone held in one hand, on the screen whose
 * whole premise is being read one-handed while you are away from the desk.
 * Neither button carried a visible label.
 *
 * Three is the floor Material 3 sets for a navigation bar rather than tabs,
 * and the ceiling it sets is five, so this is the shape the app already had —
 * it was drawn as two icons and a title instead.
 *
 * WHAT THIS IS NOT: a place for actions. Apple is explicit that a tab bar
 * supports navigation and that controls acting on the current view belong in a
 * toolbar. So Dismiss, the create `+`, refresh and the keypad all stay exactly
 * where they are. Nothing that WRITES lives here.
 *
 * Rendered on the three top-level screens only. The terminal and a single
 * space are drill-downs reached from one of these, and they keep their own
 * Back control — a tab bar there would offer a sideways move out of a screen
 * the operator opened to finish one thing.
 */
export type TabKey = "agents" | "spaces" | "settings";

/** The hash each tab is addressed by, beside the list it belongs to so the
 *  two cannot drift apart. */
export const TAB_HASH: Record<TabKey, string> = {
  agents: "#/",
  spaces: "#/spaces",
  settings: "#/settings",
};

const TABS: { key: TabKey; label: string; hash: string; Icon: typeof SpacesIcon }[] = [
  { key: "agents", label: "Agents", hash: "#/", Icon: AgentsIcon },
  { key: "spaces", label: "Spaces", hash: "#/spaces", Icon: SpacesIcon },
  { key: "settings", label: "Settings", hash: "#/settings", Icon: SettingsIcon },
];

export function TabBar({
  current,
  needsYou,
  onSelect,
}: {
  current: TabKey;
  /**
   * How many agents are in **Needs you**, counted with `sectionFor` by the
   * caller — never re-derived here from raw state, which is the defect
   * `HostHeader`'s own counts comment records ("2 needs you" over sections
   * reading "NEEDS YOU · 1").
   *
   * This is the reason the bar earns its space rather than merely moving two
   * buttons. From Spaces or Settings there was previously NO indication that
   * an agent had become blocked: the header carrying that sentence belongs to
   * the dashboard, and you had left it. Apple reserves badges for "critical
   * information", and for this app that is the single fact it exists to
   * deliver.
   */
  needsYou: number;
  /**
   * What a tap does INSTEAD of navigating.
   *
   * The anchor keeps a real `href` so the URL stays copyable and a
   * middle-click or ⌘-click still opens it — but an ordinary left tap is
   * cancelled and reported here. `App`'s `goTab` then updates the hash with
   * `replaceState`, which pushes no history entry.
   *
   * WHY: tabs are peers, not a stack. A pushed entry hands the browser's back
   * gesture a destination, and back-through-visited-tabs is a second
   * horizontal gesture meaning something different from the pager's swipe.
   */
  onSelect: (key: TabKey) => void;
}) {
  return (
    <nav className="tab-bar" aria-label="Sections">
      {TABS.map(({ key, label, hash, Icon }) => {
        const isCurrent = key === current;
        return (
          <a
            key={key}
            className="tab-item tap"
            href={hash}
            onClick={(e) => {
              // Left click with no modifier only. Stealing a ⌘/ctrl/shift
              // click would break opening a destination in a new tab or
              // window, which the real `href` above exists to allow.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              onSelect(key);
            }}
            // `aria-current`, not just a colour: the active tab is signalled by
            // hue and weight, and neither reaches a screen reader.
            aria-current={isCurrent ? "page" : undefined}
            data-current={isCurrent ? "true" : undefined}
          >
            <span className="tab-glyph-wrap">
              <Icon className="tab-glyph" />
              {/* Only ever on Agents, and only when the count is non-zero: a
                  badge showing 0 is a permanent mark that means nothing, which
                  is how a badge stops being read at all. */}
              {key === "agents" && needsYou > 0 && (
                <span
                  className="tab-badge"
                  aria-label={`${needsYou} ${needsYou === 1 ? "agent needs" : "agents need"} you`}
                >
                  {needsYou}
                </span>
              )}
            </span>
            {/* A VISIBLE label, not an aria-label standing in for one. Both
                guidelines say so outright, and the two controls this replaces
                had no label at all — a drawn glyph is only as good as the
                reader's guess about what it opens. */}
            <span className="tab-label">{label}</span>
          </a>
        );
      })}
    </nav>
  );
}
