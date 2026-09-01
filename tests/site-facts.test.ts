import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { THEMES } from "@web/prefs";

/**
 * The numbers on the landing page are FACTS, and they stay facts.
 *
 * herdr.dev's equivalent band is GitHub stars and installs to date. paddock has
 * no metric like that worth printing and will not invent one, so its four
 * numbers describe the product instead — and a number about the product goes
 * stale the moment the product changes. A theme added without this test is a
 * page claiming six when it ships seven, and nothing else in the suite reads
 * the landing page's copy at all.
 */
const html = readFileSync("site/index.html", "utf8");

/** The numeral above each label in the facts band, keyed by its label text. */
function facts(): { n: string; label: string }[] {
  const out: { n: string; label: string }[] = [];
  for (const m of html.matchAll(
    /<p class="fact-n">([^<]*)<\/p>\s*<p class="fact-l">([\s\S]*?)<\/p>/g,
  )) {
    out.push({ n: m[1]!.trim(), label: m[2]!.replace(/\s+/g, " ").trim() });
  }
  return out;
}

test("the band has four facts, and the scan can see them", () => {
  // A regex that matches nothing passes every assertion below in silence.
  expect(facts().length).toBe(4);
});

test("the theme count matches the themes the app actually offers", () => {
  // `system` is a preference — follow the browser — not a theme paddock ships.
  const shipped = THEMES.filter((t) => t.id !== "system").length;
  const claimed = facts().find((f) => /themes/.test(f.label));
  expect(claimed, "no fact mentions themes any more").toBeDefined();
  expect(
    Number(claimed!.n),
    `the page claims ${claimed!.n} themes; prefs.ts ships ${shipped}`,
  ).toBe(shipped);
});

test("the build count matches the release matrix", () => {
  const wf = readFileSync(".github/workflows/release.yml", "utf8");
  const targets = new Set([...wf.matchAll(/bun-(?:linux|darwin)-(?:x64|arm64)/g)].map((m) => m[0]));
  const claimed = facts().find((f) => /builds/.test(f.label));
  expect(claimed, "no fact mentions builds any more").toBeDefined();
  expect(
    Number(claimed!.n),
    `the page claims ${claimed!.n} builds; release.yml compiles ${targets.size}`,
  ).toBe(targets.size);
});

test("every claim in the band is a number, not a mood", () => {
  for (const f of facts()) {
    expect(f.n, `"${f.n}" is not a number`).toMatch(/^\d+$/);
    expect(f.label.length, `the numeral ${f.n} says nothing`).toBeGreaterThan(3);
  }
});

test("no fact claims a metric paddock cannot check", () => {
  // Stars, downloads and user counts are the ones that would have to be
  // invented or would rot silently. If one is ever wanted it belongs in a
  // badge that fetches it, not in static copy.
  for (const f of facts()) {
    expect(f.label.toLowerCase()).not.toMatch(/star|download|install(s| to date)|user|customer/);
  }
});
