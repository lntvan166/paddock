import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { awaitAnchor, spotlightRect } from "@site/tour/spotlight";

/**
 * The highest-risk defect in this feature, and a browser restatement of one
 * CLAUDE.md already records for TUIs: "send-keys a b c measures the later keys
 * against the frame before the earlier ones landed."
 *
 * Set the hash and measure in the same tick and the spotlight is positioned
 * against the PREVIOUS screen's layout. It looks right on a development machine
 * and wrong on a phone, which is the only device that matters here.
 *
 * The geometry half uses hand-built rects rather than real elements:
 * tests/support/dom.ts records that happy-dom implements no layout, so every
 * measured element reports zero and an assertion on real geometry would be
 * asserting nothing.
 */
afterEach(() => { document.body.innerHTML = ""; });

test("awaitAnchor waits for an element that is not there yet", async () => {
  const pending = awaitAnchor(document, "space-tree", { timeoutMs: 500 });

  // Appears a tick later, exactly as it would after a hash change repaints.
  queueMicrotask(() => {
    const el = document.createElement("ul");
    el.setAttribute("data-tour", "space-tree");
    document.body.appendChild(el);
  });

  const found = await pending;
  expect(found.getAttribute("data-tour")).toBe("space-tree");
});

test("awaitAnchor rejects rather than resolving with nothing", async () => {
  // A silent resolution here paints a spotlight at 0,0 over the corner of the
  // page, which reads as a rendering bug rather than a missing anchor.
  await expect(awaitAnchor(document, "never", { timeoutMs: 30 })).rejects.toThrow(/never/);
});

test("awaitAnchor finds an anchor that is already there", async () => {
  const el = document.createElement("div");
  el.setAttribute("data-tour", "needs-you");
  document.body.appendChild(el);
  expect(await awaitAnchor(document, "needs-you", { timeoutMs: 30 })).toBe(el);
});

const rectOf = (x: number, y: number, width: number, height: number) =>
  ({ getBoundingClientRect: () => ({ x, y, width, height }) }) as unknown as HTMLElement;

test("the rect is translated into the outer page's coordinates", () => {
  // The anchor's own rect is relative to the iframe's document. Painted without
  // the frame's offset, the spotlight lands in the top-left of the page instead
  // of over the phone.
  const r = spotlightRect(
    rectOf(10, 20, 100, 40),
    rectOf(300, 80, 390, 780) as unknown as HTMLIFrameElement,
    0,
  );
  expect(r).toEqual({ x: 310, y: 100, width: 100, height: 40 });
});

test("padding grows the hole around the control, not just below it", () => {
  const r = spotlightRect(
    rectOf(10, 20, 100, 40),
    rectOf(0, 0, 390, 780) as unknown as HTMLIFrameElement,
    6,
  );
  expect(r).toEqual({ x: 4, y: 14, width: 112, height: 52 });
});
