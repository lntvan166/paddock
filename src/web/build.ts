/**
 * Which bundle this tab is running, for display.
 *
 * NOT the same thing as `src/server/build-id.ts`. That derives an id from the
 * hashed asset filenames in the served `index.html` — the right identity for
 * COMPARING two builds, and far too long to put in a footer
 * (`index-Cj_7W-bH.js+index-9xKq2p.css`). This is the human-facing triple.
 *
 * Injected by a `define` in `vite.config.ts`. Each field falls back rather than
 * failing, because a source build with no git checkout must still produce a
 * working binary — the same contract `src/server/version.ts` already states, so
 * that a bug reported against a self-compiled binary says so.
 *
 * The fallback is the literal string "dev", never an invented hash. That is
 * `build-id.ts`'s own rule: a fabricated id makes every client believe a new
 * build just landed.
 */

// Under `bun test` there is no vite `define`, so these identifiers are not
// defined at runtime at all — a bare reference would throw a ReferenceError
// and take down every test that imports this module. Guard each with
// `typeof` before reading it.
const read = (v: string | undefined, fallback: string): string =>
  typeof v === "string" && v.length > 0 ? v : fallback;

export const BUILD = {
  version: read(typeof __PADDOCK_VERSION__ === "string" ? __PADDOCK_VERSION__ : undefined, "0.0.0-dev"),
  commit: read(typeof __PADDOCK_COMMIT__ === "string" ? __PADDOCK_COMMIT__ : undefined, "dev"),
  time: read(typeof __PADDOCK_BUILD_TIME__ === "string" ? __PADDOCK_BUILD_TIME__ : undefined, "unknown"),
} as const;
