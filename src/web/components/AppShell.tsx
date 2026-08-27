import type { ReactNode } from "react";
import { TabBar, type TabKey } from "@web/components/TabBar";

/**
 * The three tab destinations, and the one bar that names them.
 *
 * WHY THIS EXISTS. `App.tsx`, `Spaces.tsx` and `Settings.tsx` each rendered
 * their own `<TabBar>`. Three components rendering identical chrome looks
 * harmless and is not: a route change destroys the bar and builds a new one,
 * which reads on a phone as the bar blinking every time you move. Measured by
 * tagging the bar's DOM node and navigating — the tag did not survive.
 *
 * The bar is a SIBLING of the routed screen here, never a child of it. That is
 * the property doing the work; everything else in this file is layout.
 *
 * NOT used by drill-downs. An agent's terminal and a single space are pushed
 * screens with their own Back control, and `TabBar`'s own note explains why a
 * tab bar there would offer a sideways move out of a screen the operator
 * opened to finish one thing.
 */
export function AppShell({ tab, needsYou, onSelect, children }: {
  tab: TabKey;
  /** Counted with `sectionFor` by the caller — never re-derived here, which is
   *  how two screens come to disagree about one number. */
  needsYou: number;
  /** What a tab tap does instead of navigating. See `App`'s `goTab`. */
  onSelect: (key: TabKey) => void;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      {children}
      <TabBar current={tab} needsYou={needsYou} onSelect={onSelect} />
    </div>
  );
}
