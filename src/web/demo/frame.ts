import "./frame.css";

/**
 * Put the demo in a phone.
 *
 * The attribute rather than the stylesheet alone, so the framing is one flag a
 * reader can find: `frame.css` does nothing until `[data-demo-frame="on"]` is
 * set, and nothing sets it outside the demo entry.
 *
 * Imported dynamically alongside the demo backend, which keeps both the CSS and
 * this file out of the chunk an operator downloads.
 */
export function installDemoFrame(): void {
  document.documentElement.dataset.demoFrame = "on";

  /**
   * A second flag for the demo running INSIDE the site's phone.
   *
   * Measured in the live iframe: `.app-shell` is `position: fixed; inset: 0`,
   * so it is out of flow and `html`, `body` and `#root` were all zero high.
   * Chromium paints a fixed element against the iframe's viewport anyway;
   * Safari, handed a zero-height iframe document, painted a white rectangle.
   *
   * Not inferred from the width. A real phone opening the demo directly is
   * under the same breakpoint and must keep its dynamic viewport units — that
   * is what makes the keyboard inset work — so the site says it is embedding
   * and only then do the rules apply.
   */
  if (new URLSearchParams(location.search).has("embed")) {
    document.documentElement.dataset.demoEmbedded = "on";
  }
}
