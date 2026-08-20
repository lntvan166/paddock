import { realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Bytes one request may read from a journal.
 *
 * Measured on a real session: 1.5 MB across 729 records, ~2 KB per record. So
 * this is ~250 records per request — far more than one page of "show earlier",
 * and far less than a whole log. A cap on the REQUEST, not on the file: paging
 * backwards still reaches the beginning, one bounded read at a time.
 */
export const MAX_TAIL_BYTES = 512_000;

/** A session id as the harness writes it: canonical 8-4-4-4-12 hex. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value may be turned into a path AT ALL.
 *
 * Anchored on both ends and checked BEFORE any filesystem call. This is the
 * cheap half of containment: nothing with a separator, a dot segment, or an
 * extension ever reaches `realpath`.
 */
export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/**
 * Claude Code's project roots, in search order.
 *
 * A LIST because `CLAUDE_CONFIG_DIR` is per-profile and one machine can hold
 * several Claude homes. Comma-separated, trimmed, empties dropped.
 */
export function claudeRoots(env: Record<string, string | undefined>, home: string): string[] {
  const configured = (env.CLAUDE_CONFIG_DIR ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const dirs = configured.length > 0 ? configured : [join(home, ".claude")];
  return dirs.map((d) => join(d, "projects"));
}

/**
 * The resolved path, if and only if it really sits inside `root`.
 *
 * Resolved with `realpath`, never compared as strings: a symlink inside the
 * root is exactly how a path that LOOKS contained stops being contained, and a
 * journal root is a directory the operator's tools write into freely.
 *
 * The two `realpath` calls are resolved separately, and deliberately NOT
 * folded into one try/catch, because they fail for different reasons:
 *
 * - The ROOT failing to resolve is a configuration problem — a misconfigured
 *   `CLAUDE_CONFIG_DIR`, a permissions error, or a disk error. That is not
 *   "no journal here"; it is a host-side fault this process should be loud
 *   about, even though the caller still only ever sees `null`.
 * - The CANDIDATE not existing is an ordinary "no journal here" — the answer
 *   this feature reports as a fallback for a session with no log, not an
 *   exception.
 */
export async function containedRealpath(root: string, candidate: string): Promise<string | null> {
  let realRoot: string;
  try {
    realRoot = await realpath(resolve(root));
  } catch (err) {
    console.error(`journal: root does not resolve, check CLAUDE_CONFIG_DIR: ${root}`, err);
    return null;
  }

  let real: string;
  try {
    real = await realpath(resolve(candidate));
  } catch {
    return null;
  }

  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return real.startsWith(prefix) ? real : null;
}

/**
 * The last `maxBytes` of the file ending at `endByte`, and where that slice
 * began.
 *
 * Reads BACKWARDS from a byte offset rather than loading the file: paging is
 * the whole reason the route is cursored, and a 1.5 MB read per "show earlier"
 * tap on a phone is the cost this avoids. `startByte` is what the caller
 * returns as the next cursor.
 */
export async function tailChunk(
  path: string,
  endByte: number,
  maxBytes: number,
): Promise<{ text: string; startByte: number }> {
  const capped = Math.min(maxBytes, MAX_TAIL_BYTES);
  const startByte = Math.max(0, endByte - capped);
  const text = await Bun.file(path).slice(startByte, endByte).text();
  return { text, startByte };
}
