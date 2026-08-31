import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * Syntax and builtins the shipped bundle may not use, and the white phone that
 * proved nothing else was checking.
 *
 * The landing page rendered and the demo inside it was a white rectangle on
 * Safari — for two rounds, through two fixes that measured correct in Chromium.
 * The cause was one regex: `PATH_RE` in `src/web/paths.ts` used a LOOKBEHIND,
 * which Safari did not support until 16.4. vite's target is `safari14`, so
 * esbuild rewrote the literal into `new RegExp("(?<=…)")` — that keeps the
 * script PARSING, and moves the failure to module evaluation instead, where
 * `new RegExp` throws `SyntaxError` at top level. React never mounts, `#root`
 * stays empty, and an empty iframe paints its own white canvas.
 *
 * Nothing caught it. The suite runs on Bun, whose engine is JavaScriptCore —
 * the same engine family as Safari, but a current build of it, so the regex
 * constructs happily. Every one of 2382 tests passed against a bundle that
 * could not start in the browser this project is written for.
 *
 * So the bundle itself is read. This is a build-output test on purpose: the
 * defect only exists after esbuild has decided what to emit, and asserting on
 * source would have missed the `new RegExp` rewrite entirely.
 */
function bundles(dir: string): { name: string; code: string }[] {
  const assets = join(dir, "assets");
  return readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ name: join(assets, f), code: readFileSync(join(assets, f), "utf8") }));
}

const app = bundles("dist");

test("the build actually produced something to check", () => {
  // `make test` builds the UI first. A guard reading an empty directory passes
  // in silence, which is the failure mode this whole file exists to prevent.
  expect(app.length, "no bundle found in dist/assets — did the build run?").toBeGreaterThan(0);
  expect(app.reduce((n, b) => n + b.code.length, 0)).toBeGreaterThan(10_000);
});

test("no regex lookbehind reaches the browser", () => {
  // Safari 16.4. Fatal at module evaluation, not at the call site, so a single
  // one anywhere in the graph blanks the entire app.
  for (const b of app) {
    expect(b.code, `${b.name} ships a lookbehind — Safari <16.4 throws on load`).not.toContain(
      "(?<=",
    );
    expect(b.code, `${b.name} ships a negative lookbehind`).not.toContain("(?<!");
  }
});

test("paddock's own code uses no builtin newer than its browser target", () => {
  // esbuild transforms SYNTAX down to the target and leaves BUILTINS alone, so
  // `target: safari14` is not the guarantee it reads as. Scoped to our own
  // modules: a dependency reaching for `toSorted` is its own call to make, and
  // breaks at the call site rather than on load.
  const ours = readdirSync("src/web", { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => ({ name: join("src/web", f), code: readFileSync(join("src/web", f), "utf8") }));
  expect(ours.length).toBeGreaterThan(10);
  for (const f of ours) {
    for (const [api, since] of [
      [".toSorted(", "Safari 16.4"],
      [".toReversed(", "Safari 16.4"],
      ["Object.hasOwn", "Safari 15.4"],
      ["structuredClone", "Safari 15.4"],
      ["Array.fromAsync", "Safari 18.2"],
    ] as const) {
      expect(f.code, `${f.name} uses ${api}, which needs ${since}`).not.toContain(api);
    }
  }
});
