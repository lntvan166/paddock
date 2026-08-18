import { expect, test } from "bun:test";
import { buildIdFrom } from "@server/build-id";

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
