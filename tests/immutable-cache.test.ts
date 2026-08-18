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
  } catch (err) {
    // FAIL, never skip. This used to `return` when dist/ was missing — and
    // the Makefile ran the suite BEFORE the build, so on a clean checkout
    // (CI) the guard silently passed on every run without checking anything.
    // `make test` now builds the UI first; a bare `bun test` does not.
    throw new Error(
      "dist/assets is missing, so this guard would check nothing. Run `make test` " +
        "(which builds the UI first) rather than `bun test` directly. " +
        `Underlying error: ${err}`,
    );
  }

  const hashedExt = /\.(js|css|woff2|svg|png)$/;
  const candidates = entries.filter((name) => hashedExt.test(name));

  expect(candidates.length).toBeGreaterThan(0);
  for (const name of candidates) {
    expect(IMMUTABLE_ASSET_RE.test(`/assets/${name}`)).toBe(true);
  }
});

// The other half of the caching contract, and the half that was missing.
//
// Hashed assets are `immutable` for a year, which is only safe if the HTML
// that NAMES them is revalidated every load. `index.html` was served with no
// Cache-Control, no ETag and no Last-Modified at all, so browsers fell back to
// heuristic caching — and a phone that kept an old index.html then kept the
// old bundle it referenced, pinned `immutable` for a year. The symptom is a
// UI that silently never updates: an old bundle calling a since-changed API
// (POST /answer instead of POST /text) fails only in the states where the two
// disagree, which reads as intermittent rather than stale.
test("index.html is revalidated, so a hashed bundle can never be pinned forever", async () => {
  const { createApp } = await import("@server/routes");
  const { AgentStore } = await import("@server/state/store");
  const { Hub } = await import("@server/ws/hub");
  const app = createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub({ now: () => 0 }),
    staticDir: "dist",
    health: () => ({ ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: false, lastEventAt: null }),
  });

  const html = await app.request("/");
  expect(html.status).toBe(200);
  const cc = html.headers.get("cache-control") ?? "";
  expect(cc).toMatch(/no-cache|no-store|max-age=0/);

  // And the hashed asset must still be immutable, or this trade is pointless.
  const name = (await import("node:fs")).readdirSync("dist/assets").find((n) => n.endsWith(".js"));
  const asset = await app.request(`/assets/${name}`);
  expect(asset.headers.get("cache-control")).toContain("immutable");
});
