import { existsSync, readFileSync, statSync } from "node:fs";
import { expect, test } from "bun:test";
import { INSTALL_URL, SITE_URL } from "@shared/links";

/**
 * Link previews, and the reason they are asserted at all.
 *
 * Slack, Discord, iMessage and every search crawler read the HTML and none of
 * them run the page's JavaScript. This page used to build its hero with
 * `innerHTML`, so all of them received an empty `<main>` — every share of the
 * URL was a blank card, and nothing in the suite could tell.
 */
const html = readFileSync("site/index.html", "utf8");

const meta = (attr: "property" | "name", key: string): string | null => {
  const re = new RegExp(`<meta[^>]*${attr}="${key}"[^>]*>`);
  const tag = re.exec(html)?.[0];
  return tag ? (/content="([^"]*)"/.exec(tag)?.[1] ?? null) : null;
};

test("the card a share renders has a title, a description and an image", () => {
  for (const key of ["og:title", "og:description", "og:image", "og:url", "og:type"]) {
    const v = meta("property", key);
    expect(v, `${key} is missing — a share of this URL renders an empty card`).toBeTruthy();
  }
  expect(meta("name", "twitter:card")).toBe("summary_large_image");
});

test("preview URLs are absolute, because a crawler has no page to resolve against", () => {
  for (const key of ["og:url", "og:image"]) {
    expect(meta("property", key), `${key} must be absolute`).toMatch(/^https:\/\//);
  }
});

test("the site URL in this static file matches the one the code uses", () => {
  // index.html has no module graph, so SITE_URL is repeated here by hand. That
  // is exactly how two URLs drift, and the last drift advertised an install
  // command belonging to someone else.
  expect(meta("property", "og:url")).toBe(`${SITE_URL}/`);
  expect(meta("property", "og:image")).toBe(`${SITE_URL}/og.png`);
  expect(html, "the canonical link disagrees with SITE_URL").toContain(
    `<link rel="canonical" href="${SITE_URL}/" />`,
  );
  expect(html, "the hero's install command disagrees with INSTALL_URL").toContain(
    `curl -fsSL ${INSTALL_URL} | sh`,
  );
});

test("the image the card points at actually exists, at the size it claims", () => {
  // A 404 image is a card with a grey box where the screenshot should be, and
  // the tag being present is not evidence the file is.
  expect(existsSync("site/public/og.png"), "og.png is referenced but not shipped").toBe(true);
  expect(meta("property", "og:image:width")).toBe("1200");
  expect(meta("property", "og:image:height")).toBe("630");
  // Under a megabyte: several unfurlers refuse to fetch more than that, and a
  // refused image is the same grey box as a missing one.
  expect(statSync("site/public/og.png").size).toBeLessThan(1_000_000);
});

test("the headline and the install command are in the HTML, not built at runtime", () => {
  // The whole point. If someone moves these back into main.ts, every preview
  // silently goes blank again and only this test says so.
  expect(html).toContain("<h1>");
  expect(html).toMatch(/Answer your coding agents/);
  expect(html).toContain("curl -fsSL");

  const main = readFileSync("src/site/main.ts", "utf8");
  expect(main, "main.ts renders the hero again").not.toContain("<h1>");
  expect(main, "main.ts overwrites the static markup").not.toContain("root.innerHTML");
});

test("the page still says what it is for a crawler that reads only the head", () => {
  expect(meta("name", "description")).toBeTruthy();
  expect(meta("name", "description")!.length).toBeGreaterThan(50);
  // Long descriptions are truncated by every consumer; keep it inside the
  // window they actually show.
  expect(meta("name", "description")!.length).toBeLessThan(200);
});

/**
 * Every published copy of the command is the same command.
 *
 * There are three — README, the landing page's hero, and install.sh's own
 * header telling you how to read it before running it. This URL has now been
 * four hosts, and each change has to reach all three: a README that reads
 * correctly beside a hero advertising a dead one is the failure this catches.
 * The flags travel with it, since they are what makes the command work.
 */
test("every published install command agrees, URL and flags", () => {
  const sources = [
    ["README.md", readFileSync("README.md", "utf8")],
    ["site/index.html", html],
    ["install.sh", readFileSync("install.sh", "utf8")],
  ] as const;
  const flags = new Set<string>();
  for (const [name, text] of sources) {
    const cmd = /curl (-\S+) (https:\/\/\S*install\.sh)/.exec(text);
    expect(cmd, `${name} publishes no install command`).not.toBeNull();
    expect(cmd![2], `${name} advertises a URL that is not INSTALL_URL`).toBe(INSTALL_URL);
    flags.add(cmd![1]!);
  }
  expect(flags.size, `the three disagree on flags: ${[...flags].join(" vs ")}`).toBe(1);
});
