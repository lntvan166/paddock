/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set for the browser-only demo build deployed to GitHub Pages. */
  readonly VITE_PADDOCK_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Injected by vite's `define` at build time. Declared as plain `string`
 * because that is what they are in any built bundle — but under `bun test`
 * there is no vite and no define, so they are genuinely absent at runtime.
 * That is why `src/web/build.ts` guards each one with a `typeof` check that
 * this declaration makes look impossible. Do not remove those guards.
 */
declare const __PADDOCK_VERSION__: string;
declare const __PADDOCK_COMMIT__: string;
declare const __PADDOCK_BUILD_TIME__: string;
