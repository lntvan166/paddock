import { existsSync } from "node:fs";
import { childCommand } from "@server/lifecycle/commands";

/**
 * The executable path a unit file should name.
 *
 * `process.execPath` resolves symlinks, so a Homebrew install reports its
 * VERSIONED Cellar path — which `brew upgrade` deletes. A unit naming it would
 * work today and fail at the next boot after an upgrade, the one moment
 * nobody is watching. Homebrew keeps `<prefix>/opt/<name>` pointing at the
 * current version, so that is named instead — but only if it exists: a
 * guessed path is worse than the one we know works today.
 */
export function stableExecPath(
  execPath: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/([^/]+)$/.exec(execPath);
  if (m === null) return execPath;
  const opt = `${m[1]}/opt/${m[2]}/bin/${m[3]}`;
  return exists(opt) ? opt : execPath;
}

/** This exact build, no verb — a foreground paddock, which is what a unit must run. */
export function serviceArgv(
  base: string[] = childCommand(),
  exists: (p: string) => boolean = existsSync,
): string[] {
  const [exe, ...rest] = base;
  return [stableExecPath(exe!, exists), ...rest];
}
