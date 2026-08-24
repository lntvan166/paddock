import { BUILD } from "@web/build";

/**
 * Which version you are looking at.
 *
 * Sits at the bottom of the VIEWPORT rather than trailing the agent list: with
 * six agents the list ends mid-screen, and a version pinned to the end of it
 * read as a stray row. `App`'s `main` is a flex column at `min-height: 100dvh`
 * and this has `margin-top: auto`, so it drops to the bottom when the list is
 * short and still flows below the content when the list is long — where
 * `position: fixed` would sit on top of rows instead.
 *
 * Rendered OUTSIDE the staleness-dimming wrapper, deliberately. Which version
 * this bundle is remains true when the herdr link goes quiet; dimming it would
 * claim otherwise. Same reasoning `UpdateBar` already carries.
 */
export function BuildStamp() {
  return <p className="build-stamp">v{BUILD.version}</p>;
}
