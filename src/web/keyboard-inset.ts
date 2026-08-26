import { useEffect } from "react";

/**
 * How much of the screen the on-screen keyboard is covering, published as
 * `--kb-inset` on the document element.
 *
 * WHY THIS HAS TO EXIST. A bottom sheet is `position: fixed; bottom: 0`, and
 * on iOS the keyboard does NOT shrink the layout viewport — it overlays it. So
 * the sheet stays anchored to the bottom of a viewport that is now underneath
 * the keyboard, and any field near the sheet's foot is typed into blind.
 * Reported from a phone: creating a space or a tab, "the keyboard collapses
 * and hides the name text input, so I only blind type".
 *
 * `dvh` does not solve it. The dynamic viewport tracks the browser's own
 * collapsing chrome, not the keyboard, so `max-height: 85dvh` measures the
 * same before and after the keyboard opens.
 *
 * `visualViewport` is the one API that reports it. The covered height is the
 * layout viewport minus the visual one, minus how far the visual viewport has
 * been scrolled down within it — that last term matters when iOS scrolls the
 * page to reveal a focused field, which it does on its own and which would
 * otherwise be double-counted as more keyboard.
 *
 * Published as a CSS custom property rather than returned as a number, because
 * the consumer is a stylesheet rule on a shadcn component this project does
 * not own the markup of. Setting a property the rule already reads is the
 * smaller seam.
 *
 * @param active Track only while a sheet is open. A listener that runs for the
 *   life of the page would repaint `--kb-inset` on every focus anywhere —
 *   including the terminal's reply box, which is NOT in a fixed sheet and
 *   whose layout must not move when the keyboard opens.
 */
export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    // Absent on older browsers and in happy-dom. There is no fallback worth
    // writing: without this API the inset cannot be known, and guessing a
    // keyboard height per device is the kind of device detection this project
    // bans outright. The sheet then behaves exactly as it does today.
    if (!vv) return;

    const apply = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      // Clamped at 0: `visualViewport.height` can momentarily exceed
      // `innerHeight` mid-rotation, and a negative inset would push the sheet
      // off the bottom of the screen.
      const inset = Math.max(0, Math.round(covered));
      document.documentElement.style.setProperty("--kb-inset", `${inset}px`);
    };

    apply();
    vv.addEventListener("resize", apply);
    // `scroll` as well as `resize`: iOS fires scroll — not resize — when it
    // shifts the visual viewport to reveal a focused field, and `offsetTop`
    // only changes on that event.
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      // Removed, not set to 0: the rules that read this use `var(--kb-inset,
      // 0px)`, so absence and zero mean the same thing to them, and leaving a
      // stale value behind would hold the next sheet up off the bottom.
      document.documentElement.style.removeProperty("--kb-inset");
    };
  }, [active]);
}
