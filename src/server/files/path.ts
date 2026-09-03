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
 * nothing.
 *
 * RELATIVE PATHS, and why they are allowed now. This said "a relative path has
 * no single answer, because paddock cannot see the caller's working directory",
 * and that was true when it was written. It is not any more: `cwd` is on the
 * Agent payload, a transcript belongs to a pane, and a pane names an agent. The
 * route looks that cwd up in the store and passes it as `base` — server-side,
 * so the base is authoritative rather than whatever a client sent.
 *
 * With NO base the old refusal stands exactly as it was. A pane may have no
 * agent and an agent may report no cwd, and guessing one would open a file the
 * operator never named.
 */
export function resolveOpenable(
  raw: string,
  home: string | undefined,
  /** The agent's working directory, when the caller named an agent. */
  base?: string | undefined,
): string | null {
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

  // A relative path is joined to the base BEFORE the gate below, so what
  // reaches `expandHome` is already absolute. Absolute and `~` shapes skip
  // this: each already means one thing, and a base able to override them would
  // make the same link open different files in different panes.
  if (!path.startsWith("/") && !path.startsWith("~")) {
    const root = (base ?? "").trim().replace(/\/+$/, "");
    // A relative base resolves against nothing in particular — the same failure
    // this module exists to refuse — so it is not a base.
    if (!root.startsWith("/")) return null;
    path = normalise(`${root}/${path}`);
  }

  // `expandHome` also enforces "absolute, or nothing", which is the whole of the
  // validation this needs: it refuses a still-tilde path when there is no home,
  // and every relative shape.
  return expandHome(path, home);
}

/**
 * `.` and `..` resolved textually, the way a shell reads them.
 *
 * Textual rather than `realpath`: this runs before the stat, and a path that
 * does not exist yet still has to come out of here as something nameable so the
 * route can say "no file at …" with the name the operator would recognise.
 *
 * `..` above the root is dropped rather than refused. It is the same file the
 * filesystem would reach — `/..` is `/` — and refusing would be a second, more
 * confusing error for a path that simply resolves higher than expected. There
 * is no boundary being defended here: this route already opens any absolute
 * path, and Cloudflare Access is the gate for all of it.
 */
function normalise(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}
