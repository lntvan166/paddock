import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * The manifest sets "display": "standalone", so Add to Home Screen runs
 * chromeless. A same-window navigation to a cross-origin URL from a standalone
 * PWA historically renders INSIDE the app shell with no browser chrome and no
 * back button — the operator is stranded on the site and has to force quit
 * paddock to get back. iOS 16.4 and later hand such links to the browser, but
 * the older behaviour is still in the field.
 *
 * `target="_blank"` is the whole fix. It is invisible, load-bearing, and exactly
 * the sort of attribute a later tidy-up removes, which is why it is asserted
 * rather than merely commented.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("every external link opens outside the PWA, and cannot reach back into it", () => {
  let checked = 0;
  for (const p of sources("src/web")) {
    const src = readFileSync(p, "utf8");
    // Each <a ...> element whole, so its attributes are read together. `[^>]`
    // matches newlines, so a tag split over several lines is still one match.
    for (const m of src.matchAll(/<a\s[^>]*>/g)) {
      const tag = m[0];
      // External only. A relative href — the file viewer's download link — stays
      // inside the app and must NOT be forced into a new tab.
      if (!/https?:\/\/|\{(SITE_URL|TOUR_URL|INSTALL_URL)\}/.test(tag)) continue;
      checked += 1;
      expect(tag, `${p}: external link traps the PWA without target="_blank"`).toContain(
        'target="_blank"',
      );
      expect(tag, `${p}: external link is missing rel="noopener"`).toContain("noopener");
    }
  }
  // Guard the guard: a regex that matches nothing passes silently, and this
  // file's whole value is that it keeps matching as links are added.
  expect(checked, "the external-link scan found nothing to check").toBeGreaterThan(0);
});
