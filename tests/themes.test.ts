import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { THEMES } from "@web/prefs";

/**
 * Every theme must stay legible, and the check that matters most is the one
 * for colours a theme does NOT override.
 *
 * paddock's dark state colours were tuned against `--bg: #08090a`, a
 * near-black. Every popular palette uses a lighter ground, so the same hexes
 * lose contrast on it — measured, Dracula puts `--danger` at 4.25 and Nord at
 * 3.73, both below AA, on the one state this application exists to signal.
 * "Keep the state colours" is not the safe option it sounds like.
 *
 * Nothing else in the suite would catch that: no other test asserts a computed
 * colour, which is the same blind spot that let `shadcn init` turn `--accent`
 * near-white while 1159 tests passed.
 *
 * See docs/design/2026-08-26-theme-picker-design.md.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The ids that legitimately have no block of their own: `light` IS the bare
 *  `:root` palette, and `system` sets no attribute at all. `dark` has a block
 *  and is checked like any other. */
const NO_BLOCK = new Set<string>(["system", "light"]);

function tokensIn(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = (m[2] ?? "").trim();
  return out;
}

function blockFor(selector: string): Record<string, string> | null {
  const at = css.indexOf(selector + " {");
  if (at === -1) return null;
  return tokensIn(css.slice(at + selector.length + 2, css.indexOf("}", at)));
}

/** The bare `:root` palette, which every theme inherits from. Located by
 *  `\n:root {` because the selector regex used elsewhere cannot see this block —
 *  the `@custom-variant` line above it ends in `));`, so a brace-delimited
 *  match captures that whole line as part of the "selector". */
function baseTokens(): Record<string, string> {
  const at = css.indexOf("\n:root {");
  return tokensIn(css.slice(at, css.indexOf("}", at)));
}

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** WCAG 2.1 AA for text. Every pairing below is text or a control label. */
const AA = 4.5;

test("system dark applies only when no theme is pinned", () => {
  expect(css).toContain(":root:not([data-theme])");
  expect(css).not.toContain(':root:not([data-theme="light"])');
});

test("every registered theme has a block, and every block is registered", () => {
  // Two sources of truth, bound. An id with no block renders unstyled; a block
  // with no id is unreachable from the picker.
  const registered = THEMES.map((t) => t.id as string).filter((id) => !NO_BLOCK.has(id));
  const inCss = [...css.matchAll(/:root\[data-theme="([\w-]+)"\]\s*\{/g)].map((m) => m[1]!);
  expect([...new Set(inCss)].sort()).toEqual([...registered].sort());
});

/**
 * Required of every theme block.
 *
 * `--accent-fg` is required rather than optional because it is the trap this
 * codebase already walked into: a light accent needs a near-black label and a
 * dark accent needs white, and inheriting the wrong one puts white on a pale
 * fill with nothing to catch it.
 */
const REQUIRED = [
  "--bg", "--surface", "--border", "--fg", "--fg-dim",
  "--accent", "--accent-fg", "--accent-wash", "--danger-wash",
] as const;

/**
 * A theme changes hue, never geometry, type, or the terminal ground.
 *
 * `--term-bg`/`--term-fg` are dark in every theme because herdr sends the
 * agent's own truecolor escapes, chosen for a dark terminal — a light pane
 * would render an agent's white output onto a light ground. The tiles carry
 * their own backgrounds at ratios documented per hue.
 */
const FORBIDDEN = [
  "--term-bg", "--term-fg", "--tile-fg", "--mono",
  "--gutter", "--edge", "--r-sm", "--r-md", "--r-full",
  "--t-xs", "--t-md", "--t-lg", "--t-xl",
];

for (const t of THEMES.filter((x) => !NO_BLOCK.has(x.id))) {
  test(`${t.id} defines every required token`, () => {
    const block = blockFor(`:root[data-theme="${t.id}"]`);
    expect(block, `no :root[data-theme="${t.id}"] block`).not.toBeNull();
    for (const token of REQUIRED) {
      expect(block![token], `${t.id} must define ${token}`).toBeDefined();
    }
  });

  test(`${t.id} clears AA on every text pairing`, () => {
    const base = baseTokens();
    const block = blockFor(`:root[data-theme="${t.id}"]`)!;
    // The theme's own value if it set one, otherwise what it inherits.
    const v = (token: string): string => block[token] ?? base[token]!;

    const checks: [string, string][] = [
      ["--fg", "--bg"],
      ["--fg-dim", "--bg"],
      ["--fg", "--surface"],
      ["--accent", "--bg"],
      ["--accent-fg", "--accent"],
      // The three that matter most: overridden or INHERITED, they must be
      // legible on this theme's ground. Inheriting is how a theme drops below
      // AA with nobody noticing.
      ["--danger", "--bg"],
      ["--warn", "--bg"],
      ["--ok", "--bg"],
    ];

    for (const [fg, bg] of checks) {
      const r = ratio(v(fg), v(bg));
      expect(
        r,
        `${t.id}: ${fg} (${v(fg)}) on ${bg} (${v(bg)}) is ${r.toFixed(2)}, below AA ${AA}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  test(`${t.id} changes hue only, not geometry or the terminal`, () => {
    const block = blockFor(`:root[data-theme="${t.id}"]`)!;
    for (const token of FORBIDDEN) {
      expect(block[token], `${t.id} must not redefine ${token}`).toBeUndefined();
    }
    for (const key of Object.keys(block)) {
      expect(key.startsWith("--tile-"), `${t.id} must not redefine ${key}`).toBe(false);
    }
  });
}
