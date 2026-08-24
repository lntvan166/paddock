import { expect, test } from "bun:test";

const TOKENS = [
  "--bg", "--surface", "--border", "--fg", "--fg-dim", "--accent", "--warn", "--ok", "--danger", "--danger-wash",
];

async function css(): Promise<string> {
  return await Bun.file("src/web/styles.css").text();
}

test("every token is defined on bare :root", async () => {
  const text = await css();
  const root = text.slice(text.indexOf(":root {"), text.indexOf("}", text.indexOf(":root {")));
  // Match on a token boundary (name immediately followed by its colon), not a bare
  // substring: "--fg" is a literal substring of "--fg-dim", so a naive
  // `root.toContain("--fg")` would still pass even if `--fg` itself were moved out
  // of the bare :root block as long as `--fg-dim` remained — exactly the
  // regression this test exists to catch.
  for (const t of TOKENS) expect(root).toContain(`${t}:`);
});

// Deliberately NOT added to TOKENS above: that array (and its test's own
// comment about "--fg" vs "--fg-dim" token boundaries) is about the colour
// palette specifically, and --mono is a font stack, not a colour — it does
// not redefine under prefers-color-scheme or [data-theme] the way every
// TOKENS entry does, because a font stack does not change with the theme.
// Asserted here instead, once, so the "one stack, not three spellings" fix
// stays covered without blurring what TOKENS means.
test("--mono is defined once on bare :root, not per theme", async () => {
  const text = await css();
  const root = text.slice(text.indexOf(":root {"), text.indexOf("}", text.indexOf(":root {")));
  expect(root).toContain("--mono:");
  expect([...text.matchAll(/--mono:/g)]).toHaveLength(1);
});

test("dark overrides are guarded so a manual light toggle wins", async () => {
  expect(await css()).toContain(':root:not([data-theme="light"])');
});

test("an explicit dark toggle is honoured", async () => {
  expect(await css()).toContain(':root[data-theme="dark"]');
});

test("body has an explicit background token", async () => {
  expect(await css()).toMatch(/body\s*\{[^}]*background:\s*var\(--bg\)/);
});

test("no webfont is loaded", async () => {
  const text = await css();
  expect(text).not.toContain("@font-face");
  expect(text).not.toContain("fonts.googleapis");
  // Neither of the two above catches the way a webfont actually arrived here.
  // `shadcn init --preset nova` added `@import "@fontsource-variable/geist"`,
  // which is not a @font-face rule and not a Google URL — and pulled 76 KB of
  // woff2 into dist/, larger than the whole gzipped JS bundle, past a test
  // whose NAME forbids exactly that. An @import of a font package is the
  // realistic vector, so it is the one that needs asserting.
  expect(text).not.toMatch(/@import\s+["'][^"']*fontsource/i);
  expect(text).not.toMatch(/@import\s+["'][^"']*\bfonts?\b[^"']*["']/i);
});

test("no font file is shipped in the built assets", async () => {
  // The stylesheet check above can only see what is written in this file. A
  // dependency that injects @font-face from inside node_modules would not
  // appear there at all — but its woff2 lands in dist/ either way, which is
  // the thing that actually costs an operator on a slow link.
  //
  // Skipped rather than failed when dist/ is absent: `bun test` alone does not
  // build, and a test that demanded a build would fail for the wrong reason.
  const { readdirSync, existsSync } = await import("node:fs");
  if (!existsSync("dist/assets")) return;
  const fonts = readdirSync("dist/assets").filter((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f));
  expect(fonts).toEqual([]);
});

test("the state palette is traffic-light, and never paints a state in the tap colour", async () => {
  // Matches herdr so an operator moving between the two does not relearn a
  // palette: red has stopped and needs a person, amber is in motion, green is
  // finished, grey has nothing to say.
  //
  // The `--accent` assertion is the one that would silently rot. That token is
  // what every link and button uses for "you can tap this", and `working` was
  // painted with it — so a state competed with the affordances around it. A
  // future edit reaching for `--accent` because it looks nice on a dot would
  // reintroduce exactly that.
  const row = await Bun.file("src/web/components/ui/StatusDot.tsx").text();
  const map = row.slice(row.indexOf("const DOT"), row.indexOf("};", row.indexOf("const DOT")));
  expect(map).toContain('blocked: "var(--danger)"');
  expect(map).toContain('working: "var(--warn)"');
  expect(map).toContain('done: "var(--ok)"');
  expect(map).toContain('idle: "var(--fg-dim)"');
  expect(map).not.toContain("--accent");
});

test("red is defined in every theme route, not only the light one", async () => {
  // The standing rule: a colour defined only inside a media query leaves a
  // manual theme toggle painting with a value nobody chose. `--danger` arrived
  // last and is the one most likely to have been added in one place.
  const text = await Bun.file("src/web/styles.css").text();
  const bare = text.slice(text.indexOf(":root {"), text.indexOf("}", text.indexOf(":root {")));
  expect(bare).toContain("--danger:");
  // Once for the guarded media query, once for the explicit dark toggle.
  expect([...text.matchAll(/--danger:/g)]).toHaveLength(3);
});

test("the alert wash is defined in every theme route", async () => {
  // Same rule as --danger directly above: a colour defined only inside a media
  // query leaves a manual theme toggle painting with a value nobody chose.
  // Hand-picked per theme rather than color-mix(), so the value can be read
  // off the file.
  const text = await css();
  const bare = text.slice(text.indexOf(":root {"), text.indexOf("}", text.indexOf(":root {")));
  expect(bare).toContain("--danger-wash:");
  // Once bare, once for the guarded media query, once for the explicit toggle.
  expect([...text.matchAll(/--danger-wash:/g)]).toHaveLength(3);
});
