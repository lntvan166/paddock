/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set for the browser-only demo build deployed to GitHub Pages. */
  readonly VITE_PADDOCK_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Injected by vite's `define` at build time. Declared as a plain `string`
 * because that is what it is in any built bundle — but under `bun test` there
 * is no vite and no define, so it is genuinely absent at runtime. That is why
 * `src/web/build.ts` guards it with a `typeof` check this declaration makes
 * look impossible. Do not remove that guard.
 */
declare const __PADDOCK_VERSION__: string;

