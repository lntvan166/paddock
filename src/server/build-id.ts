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

/**
 * The `index.html` actually being SERVED, or null when there is none.
 *
 * This exists because the id was computed from the wrong bytes. `index.ts` read
 * `${STATIC_DIR}/index.html` off the filesystem while a compiled binary serves
 * `EMBEDDED["/index.html"]` from memory — so on an installed paddock, with no
 * `dist/` beside the binary, the id was null forever. `trackBuild` ignores a
 * null deliberately (dev mode serves unhashed assets and would otherwise show a
 * permanent prompt), which meant `UpdateBar` could never appear on the one
 * deployment it exists for: the paddock a phone leaves open for days.
 *
 * Measured on two instances of one build — `build="index-…js+index-…css"` with
 * a `dist/` present, `build=null` without.
 *
 * EMBEDDED FIRST, because that is what the browser received. Disk is the
 * fallback for a dev server with nothing embedded, and an embedded entry that
 * cannot be read falls through to it rather than failing — the id is a
 * convenience, and no answer is better than refusing to serve.
 *
 * `read` is injected so this is testable without a filesystem: the defect was
 * never in `buildIdFrom`, it was in which bytes reached it, and that decision
 * was sitting in the one file this project has no way to test.
 */
export function indexHtmlFor(
  embedded: Record<string, string>,
  staticDir: string,
  read: (path: string) => string | null,
): string | null {
  const bundled = embedded["/index.html"];
  if (bundled !== undefined) {
    const html = read(bundled);
    if (html !== null) return html;
  }
  return read(`${staticDir}/index.html`);
}
