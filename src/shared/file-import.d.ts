/**
 * `import x from "./a.js" with { type: "file" }` yields a path string that Bun
 * resolves inside a compiled binary. TypeScript has no built-in knowledge of
 * this, and the files are content-hashed build output that does not exist in a
 * fresh checkout, so a wildcard declaration is what lets `tsc --noEmit` run
 * before anything is built.
 *
 * EVERY pattern here is scoped to `../../dist/`, which is the only path shape
 * `scripts/gen-embedded.ts` ever emits. That scoping is load-bearing twice
 * over:
 *
 * 1. `*.html` needed it from the start. `bun-types` already ships
 *    `declare module "*.html"` typed as `HTMLBundle`, for Bun's separate
 *    "import an .html file as a dev-server route" feature. A second bare
 *    `"*.html"` here would merge with that one and `dist/index.html` — which
 *    wants the FILE PATH, via `with { type: "file" }`, same as every other
 *    embedded asset — would resolve to `HTMLBundle` instead of `string`.
 *
 * 2. The rest needed it for a different reason, and did not have it. Declared
 *    bare, `"*.js"` / `"*.css"` / `"*.png"` / `"*.svg"` / `"*.webmanifest"`
 *    matched ANY unresolved import ending in those extensions, anywhere in the
 *    project — so a genuinely missing relative import (a renamed file, a typo
 *    in a path) silently typed as `string` instead of failing `make check`.
 *    A declaration that exists to describe generated build output has no
 *    business answering for hand-written source.
 *
 * The wildcard in an ambient module name matches any substring, slashes
 * included, so `../../dist/*.js` covers `../../dist/assets/index-<hash>.js`
 * as well as a file at the top of `dist/`.
 */
declare module "../../dist/*.html" { const path: string; export default path; }
declare module "../../dist/*.js" { const path: string; export default path; }
declare module "../../dist/*.css" { const path: string; export default path; }
declare module "../../dist/*.png" { const path: string; export default path; }
declare module "../../dist/*.svg" { const path: string; export default path; }
declare module "../../dist/*.webmanifest" { const path: string; export default path; }
