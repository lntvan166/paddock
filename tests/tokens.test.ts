import { expect, test } from "bun:test";

const TOKENS = [
  "--bg", "--surface", "--border", "--fg", "--fg-dim", "--accent", "--warn", "--ok", "--danger", "--danger-wash",
  "--accent-wash",
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


/**
 * The type scale, and the two ways it goes wrong.
 *
 * Before it existed the app carried 34 hand-picked font sizes between 0.62rem
 * and 1.1rem — eleven distinct values inside a half-rem band, two of them
 * half-pixel (`text-[9.5px]`, `text-[12.5px]`). The effect on a phone was that
 * size could not carry hierarchy at all, so the agent name, the one string you
 * scan for while walking, was half a pixel SMALLER than the word "paddock"
 * above it.
 */
const T_STEPS = ["--t-xs", "--t-md", "--t-lg", "--t-xl"];

/**
 * Every selector allowed to size type off the scale, with the reason.
 *
 * Not a way to opt out of the scale: each of these sizes something that is not
 * paddock's own prose, and each carries a comment in the stylesheet saying so.
 * Adding a row here without such a comment is how a scale stops being one.
 */
const OFF_SCALE = [
  ".term-pane",         // agent output, sized by columns visible
  ".detail .output",    // ditto
  ".pair-code code",    // read off one screen and typed into another
  '.tile[data-size="sm"]', // initials scale with the circle, not the page
  '.tile[data-size="md"]',
  // Arrow keys size a SYMBOL, not text. On the text scale a 16px arrow sat in
  // the middle of an 80px target and read as an empty button.
  '.term-key[data-key="right"]',
  "[data-expand]",    // sizes the ▸/▾ chevron GLYPH, not text
  // Sizes the `+` GLYPH the create controls carry (§16.7), not text. On the
  // 13px prose step a `+` sat in the middle of a 44px target and read as an
  // empty button — the same defect the arrow keys above record.
  ".create-btn",
  // The same `+`, sized a second time where the header's own `font: inherit`
  // cannot outrank it — see the cascade test at the bottom of this file.
  ".spaces-head .create-btn",
];

interface Rule { sel: string; body: string }

function rules(text: string): Rule[] {
  // Comments stripped FIRST. Without this the duplicate-declaration check
  // below reported three offenders where there was one: the comment explaining
  // the bug quotes the string `font-size:` twice, so the rule that documents
  // the trap looked like the trap. A guard that counts its own prose is not
  // measuring the stylesheet.
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  // Innermost blocks only — `[^{}]*` cannot span a nested rule, so an @media
  // wrapper contributes its inner rules and never itself. The selector is the
  // last line of the capture for the same reason: inside @media the match
  // picks up the query text ahead of the selector.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ sel: m[1]!.trim().split("\n").pop()!.trim(), body: m[2]! });
  }
  return out;
}

test("no rule declares font-size twice", async () => {
  // This is not hygiene, it is a bug that already shipped. `.settings-settle
  // input` declared `font-size: 16px` with a comment explaining that iOS zooms
  // any focused input below 16px, and then declared `font-size: 0.8rem` five
  // lines later — so the field zoomed on every tap while the stylesheet said,
  // in writing, that it did not. Nothing failed: no test asserts a computed
  // size, and the comment reads correct right up to the line that cancels it.
  const offenders = rules(await css())
    .filter((r) => (r.body.match(/font-size:/g) ?? []).length > 1)
    .map((r) => r.sel);
  expect(offenders, "the last declaration wins, whatever the comments say").toEqual([]);
});

test("every font-size comes from the scale, or is a documented exception", async () => {
  const offenders = rules(await css())
    .filter((r) => /font-size:/.test(r.body))
    .filter((r) => !OFF_SCALE.includes(r.sel))
    .filter((r) => {
      const decl = r.body.match(/font-size:\s*([^;]+)/)?.[1] ?? "";
      // 16px is its own rule, not a scale step: it is the iOS zoom floor for
      // anything you can focus and type into, and it must not follow the
      // reader's text-size preference downward.
      return !T_STEPS.some((t) => decl.includes(t)) && !decl.includes("16px");
    })
    .map((r) => `${r.sel} → ${r.body.match(/font-size:\s*([^;]+)/)?.[1]?.trim()}`);
  expect(offenders, "use a --t-* step, or add the selector to OFF_SCALE with a reason").toEqual([]);
});

test("the scale's steps are far enough apart to read as different roles", async () => {
  // The failure this prevents is the one the app started from: steps close
  // enough together that no reader can tell two of them apart, which is a
  // scale on paper and a huddle on screen. 1px apart is not a step.
  const text = await css();
  const px = T_STEPS.map((t) => {
    const rem = Number(new RegExp(`${t}:\\s*([\\d.]+)rem`).exec(text)?.[1]);
    expect(rem, `${t} is not defined in rem on :root`).toBeGreaterThan(0);
    return rem * 16;
  });
  for (let i = 1; i < px.length; i++) {
    expect(px[i]! - px[i - 1]!, `${T_STEPS[i]} is too close to ${T_STEPS[i - 1]}`).toBeGreaterThanOrEqual(1.5);
  }
});


test("nothing references a scale step that does not exist", async () => {
  // The step this catches: `--t-sm` was removed from the scale for being one
  // pixel from `--t-xs`, and two `style={{ fontSize: "var(--t-sm)" }}` props in
  // AgentCard kept referencing it. An undefined custom property does not warn
  // or error — the declaration is simply invalid and the element silently
  // inherits its parent's size. tsc cannot see inside a string, so this is the
  // only place it can be caught.
  const text = await css();
  const defined = new Set([...text.matchAll(/(--t-[a-z]+):/g)].map((m) => m[1]!));
  const used = new Map<string, string[]>();
  const glob = new Bun.Glob("src/web/**/*.{ts,tsx,css}");
  for await (const file of glob.scan(".")) {
    for (const m of (await Bun.file(file).text()).matchAll(/var\((--t-[a-z]+)\)/g)) {
      if (!defined.has(m[1]!)) used.set(m[1]!, [...(used.get(m[1]!) ?? []), file]);
    }
  }
  expect([...used.entries()].map(([t, f]) => `${t} in ${[...new Set(f)].join(", ")}`)).toEqual([]);
});

/**
 * Specificity of one selector, as `(ids, classes, types)` folded into a number.
 *
 * Deliberately crude — it handles the selector shapes this stylesheet actually
 * uses (classes, attributes, bare type names, descendant combinators) and
 * nothing else. It is not a CSS engine and must not grow into one; it exists to
 * answer one question the two tests below ask.
 */
function specificity(sel: string): number {
  const classes = (sel.match(/\.[a-zA-Z][\w-]*/g) ?? []).length
    + (sel.match(/\[[^\]]*\]/g) ?? []).length;
  const types = (sel.match(/(?:^|[\s>+~])([a-z][a-z0-9]*)/g) ?? []).length;
  return classes * 100 + types;
}

test("an ancestor's font shorthand cannot outrank a glyph size it contains", async () => {
  // The bug this exists for, in full: `.create-btn` declared
  // `font-size: 1.375rem` — specificity (0,1,0) — and `.spaces-head button`
  // declared `font: inherit` — specificity (0,1,1). Specificity beats source
  // order, so the HEADER's `+` rendered its glyph at the ambient 16px while the
  // identical control on a space row rendered at 22px: the two controls §16.7
  // says must read as one thing did not, and the header one was exactly the
  // "16px mark in an empty button" defect an earlier commit is named after.
  //
  // Nothing caught it. The tests above GREP for the declaration and find it
  // present; the live check that measured the control measured its 44px tap
  // target (`min-width`/`min-height`, which no `font` shorthand touches), not
  // its glyph. So this asserts the one thing those cannot: that the rule sizing
  // a glyph OUTRANKS the ancestor rule that would otherwise reset it.
  const all = rules(await css());
  const sizes = all.filter((r) => /font(-size)?:/.test(r.body));

  // A container rule: an ancestor class plus a bare element name, setting a
  // font. `.spaces-head button { font: inherit }` is the shape.
  const containers = sizes
    .map((r) => ({ ...r, m: /^(\.[\w-]+)\s+[a-z][a-z0-9]*$/.exec(r.sel) }))
    .filter((r) => r.m !== null)
    .map((r) => ({ sel: r.sel, ancestor: r.m![1]!, spec: specificity(r.sel) }));

  const offenders: string[] = [];
  for (const glyph of OFF_SCALE.filter((s) => /^\.[\w-]+$/.test(s))) {
    for (const c of containers) {
      // Only a pairing the stylesheet itself asserts: a rule scoping this glyph
      // class inside this container is what says the two meet on one element.
      // Without that the check would guess at the DOM, which it must not.
      // Deliberately over-broad in one direction: it does not know what ELEMENT
      // the glyph class sits on, so `.spaces-head h2` counts as a container
      // even though an `h2` rule can never match a `<button>`. That is
      // tolerated rather than fixed, because the remedy is identical either way
      // — scope the glyph's size to its container — and the alternative is
      // resolving the class-to-tag mapping, which is the CSS engine this must
      // not become.
      const scoped = `${c.ancestor} ${glyph}`;
      if (!all.some((r) => r.sel === scoped)) continue;
      const won = sizes
        .filter((r) => r.sel === glyph || r.sel === scoped)
        .reduce((best, r) => Math.max(best, specificity(r.sel)), -1);
      if (won <= c.spec) {
        offenders.push(`${glyph} inside ${c.ancestor} is reset by \`${c.sel}\``);
      }
    }
  }
  expect(offenders, "move the font-size into the ancestor-scoped rule so it wins").toEqual([]);
});
