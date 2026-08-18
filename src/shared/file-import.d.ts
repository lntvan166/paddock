/**
 * `import x from "./a.js" with { type: "file" }` yields a path string that Bun
 * resolves inside a compiled binary. TypeScript has no built-in knowledge of
 * this, and the files are content-hashed build output that does not exist in a
 * fresh checkout, so a wildcard declaration is what lets `tsc --noEmit` run
 * before anything is built.
 *
 * `*.html` is deliberately NOT declared as a bare extension wildcard, unlike
 * the rest of these: `bun-types` already ships `declare module "*.html"`
 * typed as `HTMLBundle`, for Bun's separate "import an .html file as a
 * dev-server route" feature. A second bare `"*.html"` here would merge with
 * that one and `gen-embedded.ts`'s `dist/index.html` import — which wants the
 * FILE PATH, via `with { type: "file" }`, same as every other embedded asset
 * — would resolve to `HTMLBundle` instead of `string`. Scoping the pattern to
 * the one path shape `gen-embedded.ts` ever emits (`.../dist/<name>.html`)
 * is more specific than `bun-types`' bare wildcard, so it wins, and leaves
 * that other feature's typing untouched for any future genuine HTML-bundle
 * import elsewhere.
 */
declare module "../../dist/*.html" { const path: string; export default path; }
declare module "*.js" { const path: string; export default path; }
declare module "*.css" { const path: string; export default path; }
declare module "*.png" { const path: string; export default path; }
declare module "*.svg" { const path: string; export default path; }
declare module "*.webmanifest" { const path: string; export default path; }
