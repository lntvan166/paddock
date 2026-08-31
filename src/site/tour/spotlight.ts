/**
 * Where the hole goes.
 *
 * Two functions rather than one, because they fail differently: the anchor may
 * not exist yet (a repaint has not landed), or it may exist and be measured
 * against the wrong origin (an iframe's document has its own coordinate space).
 * The first is a race; the second is arithmetic.
 */

/**
 * Resolve once the anchor is in the document.
 *
 * NEVER measure across a repaint. Setting the hash and reading a rect in the
 * same tick measures the PREVIOUS screen — the browser sibling of the TUI rule
 * in CLAUDE.md, where `send-keys a b c` measured later keys against a frame the
 * earlier ones had not reached yet. Two entries in a measured-behaviour table
 * were wrong that way and both reached shipped code.
 *
 * Rejects on timeout rather than resolving with null: a spotlight painted over
 * nothing reads as a rendering bug, and the caller can say what is wrong.
 */
export function awaitAnchor(
  doc: Document,
  anchor: string,
  opts: { timeoutMs?: number } = {},
): Promise<HTMLElement> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const sel = `[data-tour="${anchor}"]`;

  const present = doc.querySelector(sel);
  if (present) return Promise.resolve(present as HTMLElement);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      fn();
    };

    // The observer must come from the document being watched: an iframe has
    // its own realm, and a constructor from the outer window observes nothing.
    const View = (doc.defaultView ?? globalThis) as unknown as typeof globalThis;
    const observer = new View.MutationObserver(() => {
      const el = doc.querySelector(sel);
      if (el) finish(() => resolve(el as HTMLElement));
    });
    observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`tour: anchor "${anchor}" never appeared`)));
    }, timeoutMs);
  });
}

/**
 * The anchor's rectangle in the OUTER page's coordinates.
 *
 * `getBoundingClientRect` inside an iframe is relative to that frame's own
 * viewport. Painted without the frame's offset the hole lands in the corner of
 * the page rather than over the phone — which looks like a broken overlay, not
 * a wrong coordinate space.
 */
export function spotlightRect(
  el: HTMLElement,
  frame: HTMLIFrameElement,
  pad = 6,
): { x: number; y: number; width: number; height: number } {
  const a = el.getBoundingClientRect();
  const f = frame.getBoundingClientRect();
  return {
    x: f.x + a.x - pad,
    y: f.y + a.y - pad,
    width: a.width + pad * 2,
    height: a.height + pad * 2,
  };
}
