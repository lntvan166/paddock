import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNewer } from "@server/update";

const REPO = "lntvan166/paddock";
const EVERY_MS = 24 * 60 * 60 * 1000;

export interface CheckOpts {
  dir: string;
  current: string;
  now: number;
  disabled?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Returns a newer version, or null.
 *
 * Deliberately NOT called on every start: that would phone GitHub each time
 * paddock runs, make a local dashboard depend on connectivity it does not
 * otherwise need, and leak usage timing. At most once per 24h, cached on disk.
 */
export async function checkForUpdate(o: CheckOpts): Promise<string | null> {
  if (o.disabled) return null;
  const file = join(o.dir, "update-check.json");

  let cache: { at?: number; latest?: string } = {};
  try {
    cache = JSON.parse(await readFile(file, "utf8")) as typeof cache;
  } catch {
    // Absent or corrupt. Either way the right move is to check again — this
    // cache is an optimisation, and losing it costs one HTTP request.
  }

  if (typeof cache.at === "number" && o.now - cache.at < EVERY_MS) {
    return cache.latest && isNewer(cache.latest, o.current) ? cache.latest : null;
  }

  let latest = "";
  try {
    const res = await (o.fetchImpl ?? fetch)(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = String(((await res.json()) as { tag_name?: string }).tag_name ?? "").replace(/^v/, "");
  } catch (e) {
    // Logged, never surfaced in the UI: a version check that cannot reach
    // GitHub is not a reason to show an error about a dashboard that works.
    console.info(`paddock: update check skipped (${(e as Error).message})`);
    return null;
  }

  await mkdir(o.dir, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ at: o.now, latest }, null, 2));
  return latest && isNewer(latest, o.current) ? latest : null;
}
