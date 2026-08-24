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
}
