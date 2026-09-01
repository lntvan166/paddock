import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * One display face, one weight, and only on the landing page.
 *
 * `src/web/styles.css` says system fonts only, because a webfont is the single
 * biggest payload on a slow link — and `tests/tokens.test.ts` enforces that for
 * the APP, which is what the rule was written about: a dashboard an operator
 * opens over a tunnel on a train. A landing page a stranger opens once is a
 * different bargain, and the headline is most of what it has to say.
 *
 * Different bargain, not no bargain. A family is cheap and a family PER ROLE is
 * not; four weights of a variable face is most of a bundle. This holds the page
 * to what was actually decided, and holds the app to none.
 */
const html = readFileSync("site/index.html", "utf8");
const siteCss = readFileSync("src/site/styles.css", "utf8");
const appCss = readFileSync("src/web/styles.css", "utf8");

// Stylesheet links only. The first draft of this counted the `preconnect` to
// the same host as a second stylesheet, then read the family off it and found
// none — a guard failing on its own scan rather than on the page.
const links = [...html.matchAll(/<link[^>]*fonts\.googleapis\.com[^>]*>/g)]
  .map((m) => m[0])
  .filter((l) => /rel="stylesheet"/.test(l));

test("the page loads exactly one font stylesheet", () => {
  expect(links.length, `${links.length} font stylesheets`).toBe(1);
});

test("it asks for one family", () => {
  const families = [...links[0]!.matchAll(/family=([^&"'>]+)/g)].map((m) => m[1]!);
  expect(families.length, `families requested: ${families.join(", ")}`).toBe(1);
});

test("it asks for one weight", () => {
  // `wght@12..96,800` is an optical-size range at a single weight. Two weights
  // would be `800;400` or a `wght@400..800` range, and both double the file.
  const weights = /wght@[^,&"']*,([\d;]+)/.exec(links[0]!)?.[1] ?? "";
  expect(weights, "no weight pinned — the request may serve the whole range").toBeTruthy();
  expect(weights.split(";").length, `weights requested: ${weights}`).toBe(1);
});

test("the font never blocks first paint", () => {
  // Without swap, a slow font server is a page with no headline on it.
  expect(links[0]).toContain("display=swap");
  expect(html, "no preconnect — the font handshake is a cold round trip").toContain(
    "rel=\"preconnect\"",
  );
});

test("prose is still system-ui; the webfont is for display only", () => {
  // The saving is that body text — the bulk of the glyphs — needs no download.
  expect(siteCss).toMatch(/font:[^;]*system-ui/);
  expect(siteCss, "--site-display is not declared").toContain("--site-display");
});

test("the app is untouched by any of this", () => {
  // The rule this page is an exception to still binds everywhere else.
  expect(appCss).not.toContain("fonts.googleapis");
  expect(appCss).not.toContain("@font-face");
  // Skipped rather than failed when dist/ is absent: `bun test` alone does not
  // build, and `make test` does.
  if (!existsSync("dist/assets")) return;
  const fonts = readdirSync("dist/assets").filter((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f));
  expect(fonts, "a font file reached the app bundle").toEqual([]);
});
