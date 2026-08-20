import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNewer } from "@server/update";

const REPO = "lntvan166/paddock";
const EVERY_MS = 24 * 60 * 60 * 1000;

/** The version a build with no git tag reports — see @server/version. */
const DEV_VERSION = "0.0.0-dev";

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
  // A dev build never has an update to offer, so it must not ask for one.
  // `isNewer(anything, "0.0.0-dev")` is true for every published release, so
  // without this `make dev` renders "paddock X available — run: paddock
  // update" permanently — and running that command answers "this is a dev
  // build", because update.ts refuses a 0.0.0-dev binary by design. A notice
  // whose only advice is a command that declines is worse than no notice.
  // Returning here rather than at the comparison also means a dev loop makes
  // no request to GitHub and writes no cache file at all.
  if (o.current === DEV_VERSION) return null;
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

  // The persist has its OWN try/catch, and it is not optional.
  //
  // Measured on a compiled binary with PADDOCK_CONFIG_DIR pointing at a 0500
  // directory: the server bound its port, served requests, and then died with
  // `EACCES: permission denied, mkdir ...` and exit 1, because this rejection
  // escaped the fetch's catch above and Bun terminates the process on an
  // unhandled rejection. It is reachable on the path this repo ships:
  // oven/bun:1-alpine has a passwd entry only for uid 1000 and
  // docker-compose.yml runs `user: "${UID}:${GID}"` from the host, so on any
  // machine whose UID is not 1000 `homedir()` is `/`, this mkdir is EACCES,
  // and with `restart: unless-stopped` the container crash-loops.
  //
  // Logging rather than rethrowing is the ONE sanctioned exception to "never
  // swallow errors" in this repo (docs/design/2026-08-18-...: failure is
  // silent in the UI and logged at INFO) — and it is only sanctioned because
  // it still logs. The cache is an optimisation; losing it costs one HTTP
  // request a day. A dashboard that works is not worth killing over it.
  try {
    await mkdir(o.dir, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ at: o.now, latest }, null, 2), { mode: 0o600 });
    // `writeFile`'s mode applies only when it CREATES the file and is subject
    // to the umask; this is neither. Same posture as settings.json next to it:
    // this file records when the operator's machine last contacted GitHub, so
    // it is nobody else's business either.
    await chmod(file, 0o600);
  } catch (e) {
    console.info(`paddock: update check not cached (${(e as Error).message})`);
  }
  return latest && isNewer(latest, o.current) ? latest : null;
}

/**
 * Fires the check WITHOUT awaiting it and hands the result to `onResult`.
 *
 * This exists so the `.catch` cannot be forgotten at the call site, which is
 * the second half of the crash above: `src/server/index.ts` had
 * `void checkForUpdate(...).then(...)` with no rejection handler at all, so
 * ANY throw inside the check — not merely today's known one — took the whole
 * server down after it had already started serving. The check is allowed to
 * fail; it is not allowed to be fatal.
 *
 * `check` is injectable for one reason: to test that this catch works, a
 * rejection has to come from somewhere, and `checkForUpdate` is now careful
 * enough not to produce one.
 */
export function startUpdateCheck(
  o: CheckOpts,
  onResult: (latest: string | null) => void,
  check: (o: CheckOpts) => Promise<string | null> = checkForUpdate,
): void {
  void check(o)
    .then(onResult)
    .catch((e: unknown) => {
      console.info(`paddock: update check failed (${(e as Error).message})`);
    });
}

/**
 * The env-var opt-out (`PADDOCK_NO_UPDATE_CHECK=1`), isolated so the mapping
 * itself has a unit test.
 *
 * Fix round 1: this used to be an inline `process.env.PADDOCK_NO_UPDATE_CHECK
 * === "1"` at the `index.ts` call site, exercised only via `checkForUpdate`'s
 * library-level `disabled: true` — which proves the library respects the
 * flag, not that `index.ts` reads the right variable or the right operator. A
 * `!==` for `===` typo (or the wrong variable name entirely) would have
 * compiled and passed every existing test.
 */
export function noUpdateCheckRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PADDOCK_NO_UPDATE_CHECK === "1";
}

/**
 * How often the schedule below wakes up. NOT how often GitHub is asked.
 *
 * `checkForUpdate` owns the rate limit — the on-disk cache means a call inside
 * 24h answers from `update-check.json` and makes no request. So this timer only
 * decides how soon after that day expires the answer is noticed, and an hourly
 * disk read is cheap enough not to think about. Do not "optimise" this to 24h:
 * a tick that lines up exactly with the cache window would be one drifting
 * millisecond away from waiting two days.
 */
const RECHECK_MS = 60 * 60 * 1000;

export interface ScheduleHandle {
  stop: () => void;
}

/**
 * Keep asking, for as long as paddock runs.
 *
 * `startUpdateCheck` fires exactly once, which is right for a command that
 * exits and wrong for a server. Measured consequence: a paddock started before
 * a release existed reported `latestKnown: null` forever — so the dashboard's
 * notice and the terminal's both faithfully displayed a value that could never
 * change. `paddock start` and a dashboard left open on a phone are the two
 * documented ways to use this thing, and both were the case that never learned.
 *
 * `make` is a FACTORY, not a value: `CheckOpts.now` is a timestamp, and a
 * captured one would make every tick look like the same instant to the cache
 * comparison — the cache would then never appear to expire, which is the
 * original bug wearing a timer.
 *
 * A rejection is reported and the schedule CONTINUES. A laptop that was offline
 * for one tick must not stop checking for the rest of the process's life, and
 * the throw must not be fatal — same reasoning as `startUpdateCheck`, which
 * this delegates to for exactly that reason rather than restating the `.catch`.
 */
export function scheduleUpdateChecks(
  make: () => CheckOpts,
  onResult: (latest: string | null) => void,
  opts: { everyMs?: number; check?: (o: CheckOpts) => Promise<string | null> } = {},
): ScheduleHandle {
  const everyMs = opts.everyMs ?? RECHECK_MS;
  const run = () => startUpdateCheck(make(), onResult, opts.check);
  run(); // immediately: the first answer must not wait a full interval
  const timer = setInterval(run, everyMs);
  // Never the reason the process stays alive. The server's own listener is.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
