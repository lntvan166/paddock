/**
 * Which build the server is serving, so a browser can notice it is stale.
 *
 * `index.html` is served `no-cache`, which guarantees a FRESH load always gets
 * the current bundle. It does nothing for a tab that is already open: that tab
 * keeps running whatever JavaScript it loaded until someone reloads it, and
 * nothing tells it a newer build exists. On a phone left open on a dashboard,
 * that tab can be days old.
 *
 * The cost of not knowing is not theoretical — it has produced two separate
 * debugging detours in this project, both spent looking for a bug in the
 * running code that had already been fixed in the code on disk.
 *
 * The identity is Vite's content-hashed bundle filename, which is exactly what
 * changes when, and only when, the shipped JavaScript changes.
 */

/**
 * Matches every hashed asset the document references.
 *
 * The alphabet is dash-separated base64url (`index-Cj_7W-bH.js`), NOT hex.
 * A hex-only pattern is the mistake `IMMUTABLE_ASSET_RE` made once already:
 * it matched no real build output at all, and the feature it guarded was dead
 * code for as long as nobody checked.
 */
const ASSET_RE = /assets\/([A-Za-z0-9._-]+\.(?:js|css))/g;

/**
 * The build id in a served `index.html`, or null if there is no hashed bundle.
 *
 * Null rather than a placeholder: dev mode serves through Vite with unhashed
 * assets, and inventing an id there would make every client believe a new
 * build had just landed, on every single message, forever.
 */
export function buildIdFrom(html: string): string | null {
  // EVERY hashed asset, not just the script. A CSS-only change leaves the JS
  // hash untouched, and a build id derived from the script alone would call
  // that "no new build" — which is precisely the case a stylesheet fix ships
  // in. Found by rebuilding after a CSS edit and watching nothing happen.
  const names = [...html.matchAll(ASSET_RE)].map((m) => m[1]!);
  return names.length ? [...new Set(names)].sort().join("+") : null;
}
