import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Bun's own networking globals, captured BEFORE happy-dom replaces them.
 *
 * Bun runs every test file in one process, so registering a DOM in this file
 * changes globals for files that never asked for one. happy-dom's `Response`
 * is not Bun's: `.text()` on it returns "[object Blob]", which broke a server
 * test asserting on a served HTML body — a failure with no visible connection
 * to the DOM being added.
 *
 * Component tests need `document`. They stub `fetch` themselves and never want
 * happy-dom's implementation of it, so the native ones are put back below.
 */
const nativeFetch = globalThis.fetch;
const nativeResponse = globalThis.Response;
const nativeRequest = globalThis.Request;
const nativeHeaders = globalThis.Headers;

/**
 * A DOM for component tests, registered once before any test file loads.
 *
 * The repo had no DOM environment at all, so every component effect and every
 * piece of wiring was unverified. That was not a theoretical gap: three
 * defects reached the browser in a single cycle and were all found by hand —
 * a refresh loop suppressed until the pane froze, an "Enter selects" preview
 * that vanished on the first arrow-down, and a stylesheet class renamed on one
 * side only. The first two are effects, reachable only from a rendered
 * component.
 *
 * Imported FIRST by each component test file, not preloaded globally. A global
 * preload gives every test a DOM, including server tests that must not have
 * one: it made `install.test.ts` fail (it hand-fakes `window`, which happy-dom
 * makes readonly) and `static.test.ts` fail (happy-dom's `Response` returns
 * "[object Blob]" from `.text()` where Bun's native one returns the body).
 *
 * Import order matters and is load-bearing: React reads `document` when it is
 * imported, so this must come before any component import in the file.
 */
GlobalRegistrator.register();

/**
 * Tells React that `act()` is expected here. Without it every render logs
 * "The current testing environment is not configured to support act(...)",
 * and warning noise is how a real warning gets missed.
 */
// Put Bun's networking back. Only the DOM half of happy-dom is wanted here.
globalThis.fetch = nativeFetch;
globalThis.Response = nativeResponse;
globalThis.Request = nativeRequest;
globalThis.Headers = nativeHeaders;

/**
 * Tells React that `act()` is expected here. Without it every render logs
 * "The current testing environment is not configured to support act(...)",
 * and warning noise is how a real warning gets missed.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom does not implement layout, so anything that measures is inert
// rather than absent. Stubbed explicitly so a test that depends on geometry
// fails loudly here instead of silently reading zero.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo(): void {
    throw new Error(
      "scrollTo is not implemented in happy-dom; assert on scrollTop, or drive " +
        "this behaviour with the CDP harness instead of a unit test",
    );
  };
}
