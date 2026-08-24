/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set for the browser-only demo build deployed to GitHub Pages. */
  readonly VITE_PADDOCK_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __PADDOCK_VERSION__: string;
declare const __PADDOCK_COMMIT__: string;
declare const __PADDOCK_BUILD_TIME__: string;
