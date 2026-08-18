import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

// Every URL in the manifest must be RELATIVE, and the reason is a failure that
// hides in the deployment nobody installs from.
//
// `build:demo` runs vite with --base=/paddock/, because GitHub Pages serves a
// project site from a sub-path. Vite rewrites the href/src attributes it finds in
// index.html, so the favicon and apple-touch-icon links come out correct. It does
// NOT rewrite files copied verbatim out of public/, and the manifest is one of
// those. A root-absolute "/icon-192-v2.png" therefore survives the build intact
// and, on the demo, points at the domain root rather than /paddock/ — a 404, and
// a PWA with no icons.
//
// It stays invisible on the real deployment, which is served from a domain root
// where the absolute path happens to be right. That asymmetry is the trap: the
// version anyone tests by hand works, and the published one does not.
//
// Relative URLs resolve against the manifest's own location, so they are correct
// in both: "icon-192-v2.png" beside /manifest.webmanifest is /icon-192-v2.png,
// and beside /paddock/manifest.webmanifest is /paddock/icon-192-v2.png.
test("no manifest URL is root-absolute, so a base path cannot break it", () => {
  const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));

  const urls: Array<[string, string]> = [
    ["start_url", manifest.start_url],
    ...manifest.icons.map(
      (icon: { src: string }, i: number) => [`icons[${i}].src`, icon.src] as [string, string],
    ),
  ];

  // Guard the guard: if the manifest is restructured so these fields stop
  // existing under these names, this test must fail rather than quietly check an
  // empty list — the same way the dist/assets listing is asserted non-empty.
  expect(urls.length).toBeGreaterThanOrEqual(4);

  for (const [field, url] of urls) {
    expect(url, `${field} must be set`).toBeTruthy();
    expect(url.startsWith("/"), `${field} is root-absolute ("${url}")`).toBe(false);
  }
});
