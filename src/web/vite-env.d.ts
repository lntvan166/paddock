/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set for the browser-only demo build deployed to GitHub Pages. */
  readonly VITE_PADDOCK_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
