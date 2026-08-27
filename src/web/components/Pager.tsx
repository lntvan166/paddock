import { Dashboard } from "@web/components/Dashboard";
import { Settings } from "@web/components/Settings";
import { Spaces } from "@web/components/Spaces";
import type { TabKey } from "@web/components/TabBar";

/** Tab order, left to right. `TabBar`'s own list must agree with this, and
 *  `tests/pager.test.tsx` fails if the two ever drift. */
export const PAGER_TABS = ["agents", "spaces", "settings"] as const satisfies readonly TabKey[];

/**
 * The three tab destinations, side by side in one track.
 *
 * WHY ALL THREE ARE MOUNTED. Finger-tracking needs the neighbouring screen
 * already on screen at the moment a drag begins — there is no time to mount
 * one mid-gesture. Three consequences, all wanted: each tab keeps its scroll
 * position; `useSpaceTree` never unmounts, so the "Spaces reloads every time"
 * report is deleted rather than cached around; and two tabs are alive while
 * off-screen, which is why the poll gates on `active` rather than on
 * `document.hidden` alone.
 *
 * The transform is in PERCENT, not pixels: percent needs no measurement, so
 * the track is correct on the first paint and after any resize without a
 * layout read. `Pager` owns no arithmetic — the feel lives in
 * `pager-gesture.ts` so it can be tested without a DOM.
 */
export function Pager({ index, onIndexChange }: {
  index: number;
  onIndexChange: (i: number) => void;
}) {
  void onIndexChange;  // bound to touch events in the next task

  return (
    <div className="pager-viewport">
      <div
        className="pager-track"
        style={{ transform: `translate3d(${-index * 100}%, 0, 0)` }}
      >
        {PAGER_TABS.map((tab, i) => (
          <div
            key={tab}
            className="pager-page"
            data-tab={tab}
            // Two of the three are off-screen but present. Unmarked, a screen
            // reader reads all three as one long page and the tab bar stops
            // meaning anything.
            aria-hidden={i === index ? undefined : true}
          >
            {tab === "agents" && <Dashboard active={i === index} />}
            {tab === "spaces" && <Spaces active={i === index} />}
            {tab === "settings" && <Settings />}
          </div>
        ))}
      </div>
    </div>
  );
}
