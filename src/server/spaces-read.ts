/**
 * The Spaces read over both backends: terminal herdr's tree and the app's
 * spaces, each allowed to fail on its own.
 *
 * It was a `Promise.all`, so a terminal herdr that was not running made the
 * whole read fail and the Spaces screen of an app-only paddock was a
 * permanent error, even with app spaces to show. Now:
 *
 * - both answer: herdr's spaces first, then the app's (`merge`);
 * - herdr fails, the app has spaces: the app's spaces alone;
 * - the app's read fails (including shaping its tree): herdr's tree alone;
 * - herdr fails and the app has nothing to show: herdr's error, as before —
 *   an empty screen would claim there are no spaces when paddock could not
 *   read them.
 *
 * Each one-sided failure is said once per distinct reason at INFO, not on
 * every refresh. Knows neither backend: both reads and the merge are passed in.
 */
import type { Space, SpaceTree } from "@shared/types";

export interface SpacesReaderOptions {
  /** Terminal herdr's tree. */
  herdr: () => Promise<SpaceTree>;
  /** The app's spaces, or null when no core is connected (nothing to read). */
  core: (() => Promise<Space[] | null>) | null;
  merge: (herdr: SpaceTree | null, core: Space[] | null, now: number) => SpaceTree;
  now?: () => number;
}

export function createSpacesReader(o: SpacesReaderOptions): () => Promise<SpaceTree> {
  const now = o.now ?? Date.now;
  const said = new Set<string>();
  const sayOnce = (msg: string) => {
    if (said.has(msg)) return;
    said.add(msg);
    console.info(msg);
  };

  return async () => {
    // `async () => o.core()` so a synchronous throw inside the core read lands
    // here as a rejection rather than escaping allSettled.
    const [herdr, core] = await Promise.allSettled([
      o.herdr(),
      o.core ? (async () => o.core!())() : Promise.resolve(null),
    ]);
    const at = now();

    if (core.status === "rejected") {
      if (herdr.status === "rejected") throw herdr.reason;
      sayOnce(`spaces: the app's spaces could not be read (${messageOf(core.reason)}); showing terminal herdr's only`);
      return o.merge(herdr.value, null, at);
    }
    if (herdr.status === "rejected") {
      if (!core.value || core.value.length === 0) throw herdr.reason;
      sayOnce(`spaces: terminal herdr's tree could not be read (${messageOf(herdr.reason)}); showing the app's spaces only`);
      return o.merge(null, core.value, at);
    }
    return o.merge(herdr.value, core.value, at);
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
