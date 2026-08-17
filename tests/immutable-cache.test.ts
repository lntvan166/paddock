import { readdirSync } from "node:fs";
import { expect, test } from "bun:test";
import { IMMUTABLE_ASSET_RE } from "@server/routes";

// Guards against the regex silently drifting from what Vite actually emits —
// found in review: the original pattern required dot-separated lowercase hex
// (`\.[0-9a-f]{8,}\.`), but Vite's real hash is dash-separated base64url
// (e.g. "index-BRl8nQbG.js", "index-Cj_7W-bH.css"), so the old pattern never
// matched a single real build output and the immutable cache header was dead
// code. This reads the actual `dist/assets` listing rather than a
// hand-picked example, so a future hashing-scheme change fails this test
// instead of silently disabling long-lived caching again.
test("every hashed asset Vite actually builds matches the immutable-cache regex", () => {
  let entries: string[];
  try {
    entries = readdirSync("dist/assets");
  } catch {
    // dist/ not built yet in this environment — nothing to check. `make
    // build` runs `bun run build:web` before this suite would matter in CI.
    return;
  }

  const hashedExt = /\.(js|css|woff2|svg|png)$/;
  const candidates = entries.filter((name) => hashedExt.test(name));

  expect(candidates.length).toBeGreaterThan(0);
  for (const name of candidates) {
    expect(IMMUTABLE_ASSET_RE.test(`/assets/${name}`)).toBe(true);
  }
});
