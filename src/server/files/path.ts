import { expandHome } from "@server/herdr/tree";

/**
 * A path as the operator's terminal spelled it, turned into one the filesystem
 * understands — or null.
 *
 * WHY THIS EXISTS. `web/paths.ts` linkifies three forms: an absolute path, a
 * `~` path, and a `file://` URL. Only the first is something `statSync` can
 * open. Found by using the feature rather than by a test: writing out a `~/…`
 * path and tapping it answered "no file at ~/…", because expanding a tilde is a
 * shell's job and nothing here is a shell. Every form the transcript offers as
 * a link has to be a form this accepts, or the feature ships a tap that always
 * fails.
 *
 * The tilde half delegates to `expandHome`, which the create routes already
 * use — one expander, not two, so a future change to what `~` means cannot
 * apply to half of paddock. Its final gate is borrowed too: absolute, or
 * nothing. A relative path has no single answer, because paddock cannot see the
 * caller's working directory.
 */
export function resolveOpenable(raw: string, home: string | undefined): string | null {
  let path = raw.trim();
  if (path === "") return null;

  if (path.startsWith("file://")) {
    // `file:///srv/a` → `/srv/a`. The authority is empty for a local file, so
    // what follows the third slash is the path.
    path = path.slice("file://".length);
    try {
      // Percent-encoding belongs to the URL, not to the name on disk.
      path = decodeURIComponent(path);
    } catch {
      // A malformed escape is not a reason to fail the request — the bytes may
      // genuinely contain a `%`. Left as they are, and the stat decides.
    }
  }

  // `expandHome` also enforces "absolute, or nothing", which is the whole of the
  // validation this needs: it refuses a still-tilde path when there is no home,
  // and every relative shape.
  return expandHome(path, home);
}
