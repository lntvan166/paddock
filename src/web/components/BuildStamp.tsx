import { BUILD } from "@web/build";

/**
 * Which bundle you are looking at.
 *
 * Twice in this project a bug was hunted in code that had already been fixed,
 * because the tab under test was stale. `UpdateBar` catches that when the
 * server's id changes while a tab is open; this answers the other question —
 * "what am I running right now" — without a reload or a devtools trip.
 */
export function BuildStamp() {
  return (
    <p className="build-stamp">
      v{BUILD.version} · {BUILD.commit} · {BUILD.time}
    </p>
  );
}
