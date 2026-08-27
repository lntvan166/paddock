import { expect, test } from "bun:test";
import { buildIdFrom, indexHtmlFor } from "@server/build-id";

// The whole point: an already-open tab keeps running the JS it loaded, and
// nothing tells it a new build exists. `index.html` is served `no-cache` so a
// FRESH load always revalidates, but that does nothing for a tab that is
// already open — which is exactly the tab an operator leaves on a phone.

test("the hashed bundle name is the build identity", () => {
  const html = `<!doctype html><html><head>
    <script type="module" crossorigin src="/assets/index-BclM8Fq9.js"></script>
    <link rel="stylesheet" href="/assets/index-DAeaPTiu.css">
  </head><body><div id="root"></div></body></html>`;
  // Both hashed assets, sorted, so the id is stable regardless of tag order.
  expect(buildIdFrom(html)).toBe("index-BclM8Fq9.js+index-DAeaPTiu.css");
});

test("a rebuild changes the id, which is the signal the client acts on", () => {
  const a = buildIdFrom(`<script src="/assets/index-AAAAAAAA.js"></script>`);
  const b = buildIdFrom(`<script src="/assets/index-BBBBBBBB.js"></script>`);
  expect(a).not.toBe(b);
  expect(a).toBeTruthy();
});

test("Vite's real hash alphabet is accepted, not just hex", () => {
  // Dash-separated base64url, e.g. "index-Cj_7W-bH.js". A hex-only pattern
  // matched no real build output — the same mistake the immutable-cache regex
  // made once already.
  expect(buildIdFrom(`<script src="/assets/index-Cj_7W-bH.js"></script>`))
    .toBe("index-Cj_7W-bH.js");
  expect(buildIdFrom(`<script src="/assets/index-B_q1-UaD.js"></script>`))
    .toBe("index-B_q1-UaD.js");
});

test("html with no hashed bundle yields null rather than a wrong id", () => {
  // Dev mode serves through Vite with no hashed asset. Returning a made-up id
  // would make every client believe a new build had landed, forever.
  expect(buildIdFrom(`<html><body>no bundle here</body></html>`)).toBeNull();
  expect(buildIdFrom("")).toBeNull();
});

test("every hashed asset contributes, in a stable order", () => {
  const html = `<script src="/assets/index-ZZZZZZZZ.js"></script>
                <script src="/assets/index-AAAAAAAA.js"></script>`;
  expect(buildIdFrom(html)).toBe("index-AAAAAAAA.js+index-ZZZZZZZZ.js");
});

test("a CSS-only change moves the build id", () => {
  // The case that made this necessary: rebuilding after a stylesheet edit
  // leaves the JS hash untouched, so a script-only id reports no new build
  // for exactly the kind of fix that ships in a stylesheet.
  const a = buildIdFrom(`<script src="/assets/index-SAME.js"></script>
                         <link href="/assets/index-AAAA.css">`);
  const b = buildIdFrom(`<script src="/assets/index-SAME.js"></script>
                         <link href="/assets/index-BBBB.css">`);
  expect(a).not.toBe(b);
});

// ---- which bytes the id is computed FROM ----------------------------------
//
// MEASURED as broken before this existed: `currentBuildId` in `index.ts` read
// `${STATIC_DIR}/index.html` from disk, while a compiled binary serves
// `EMBEDDED["/index.html"]` from memory. Two instances of the same build, one
// with a `dist/` beside it and one without, put this on the wire:
//
//     dist present   build="index-95d73f7Q.js+index-DDwPjkee.css"
//     no dist        build=null
//
// A null is ignored by `trackBuild` on purpose (dev mode serves unhashed
// assets), so `UpdateBar` could never appear on an installed binary — the one
// deployment the feature exists for, since that is the paddock a phone leaves
// open for days. The fix is to read whatever is actually SERVED, so the id
// cannot disagree with the bundle the browser got.

test("the embedded document is preferred, because that is what is served", () => {
  const read = (p: string) =>
    p === "/embedded/index.html" ? '<script src="/assets/index-EMBED01.js"></script>' : null;

  expect(indexHtmlFor({ "/index.html": "/embedded/index.html" }, "dist", read))
    .toContain("index-EMBED01.js");
});

test("disk is the fallback, for a dev server with nothing embedded", () => {
  const read = (p: string) =>
    p === "dist/index.html" ? '<script src="/assets/index-DISK01.js"></script>' : null;

  expect(indexHtmlFor({}, "dist", read)).toContain("index-DISK01.js");
});

test("neither present is null, not a throw", () => {
  // A fresh checkout with no build. `null` means "cannot tell", which the
  // client already treats as "nothing to announce".
  expect(indexHtmlFor({}, "dist", () => null)).toBeNull();
});

test("an unreadable embedded document falls back rather than failing", () => {
  const read = (p: string) => (p === "dist/index.html" ? "<html>disk</html>" : null);
  expect(indexHtmlFor({ "/index.html": "/gone" }, "dist", read)).toBe("<html>disk</html>");
});
