/**
 * Which version this tab is running, for display.
 *
 * NOT the same thing as `src/server/build-id.ts`. That derives an id from the
 * hashed asset filenames in the served `index.html` — the right identity for
 * COMPARING two builds, and far too long to put in a footer
 * (`index-Cj_7W-bH.js+index-9xKq2p.css`).
 *
 * This carried `version · commit · time` at first. The commit was the field
 * that distinguished two builds of the SAME version — but noticing a stale tab
 * is `UpdateBar`'s job, and it does it by comparing the server's build id
 * rather than by anyone reading this footer. So the footer answers one
 * question, and the commit and build-time defines were removed rather than
 * left plumbed to nothing.
 *
 * Injected by a `define` in `vite.config.ts`, and falling back rather than
 * failing: a source build with no tag must still produce a working binary, and
 * must SAY it is a source build. That is the contract
 * `src/server/version.ts` already states, for the same reason — a bug reported
 * against a self-compiled binary needs to identify itself.
 */

// Under `bun test` there is no vite `define`, so this identifier is not
// defined at runtime at all — a bare reference would throw a ReferenceError
// and take down every test that imports this module. The `typeof` guard is
// load-bearing; see the note in `src/web/vite-env.d.ts`.
const injected = typeof __PADDOCK_VERSION__ === "string" ? __PADDOCK_VERSION__ : undefined;

export const BUILD = {
  version: injected !== undefined && injected.length > 0 ? injected : "0.0.0-dev",
} as const;
