import { rm } from "node:fs/promises";
import { join } from "node:path";
import { warn as termWarn } from "@server/term";
import {
  capturedArgs, checkRecord, systemProbe, writeRecord,
  type Check, type Probe, type TrackedRecord,
} from "@server/lifecycle/state";

/**
 * What a running tunnel records about itself.
 *
 * SEPARATE FROM `paddock.state.json`, and that separation is the design.
 * `recordState` is first-instance-wins per config dir — its own comment
 * carries the scar of a second instance silently taking over the first's
 * record, which left the instance actually holding the port untrackable for
 * the rest of its life. A `--publish-running` tunnel exists specifically to
 * run beside a recorded paddock, so it could never claim that file and must
 * not try.
 *
 * NO PAIRING CODE HERE, ever. `Pairing.current()` mints lazily, so a code
 * copied out to a file is a snapshot that may already be past `expiresAt`
 * when someone reads it — and a reader cannot mint. `control` is how the code
 * is obtained instead: by asking the process that can. See
 * docs/design/2026-08-26-detached-tunnel.md §2.
 */
export interface TunnelState extends TrackedRecord {
  /** The public URL. Not a secret — it is the thing you send someone. */
  url: string;
  /** Absolute path of this tunnel's control socket. */
  control: string;
  /** Upstream port when publishing a paddock already running, else null. */
  publishing: number | null;
  startedAt: number;
  /** The `--for` deadline, or null for "until stopped". */
  until: number | null;
}

export function tunnelStateFile(dir: string): string {
  return join(dir, "paddock.tunnel.json");
}

export function controlSocket(dir: string): string {
  return join(dir, "tunnel.sock");
}

/**
 * `url` and `control` are checked as strictly as `pid` and `args`, because
 * both are dereferenced rather than merely reported: `pair` renders a QR of
 * `${url}/#${code}` and connects to `control`. A record missing either would
 * hand out a real pairing code on a QR reading `undefined/#…`.
 */
export function isTunnelState(v: unknown): v is TunnelState {
  const s = v as TunnelState;
  return typeof s === "object" && s !== null &&
    typeof s.pid === "number" && typeof s.args === "string" &&
    typeof s.url === "string" && typeof s.control === "string";
}

export async function writeTunnelState(dir: string, s: TunnelState): Promise<void> {
  await writeRecord(dir, tunnelStateFile(dir), s);
}

export async function checkTunnelState(
  dir: string,
  probe: Probe = systemProbe,
  log: (line: string) => void = termWarn,
): Promise<Check<TunnelState>> {
  return await checkRecord(tunnelStateFile(dir), isTunnelState, probe, log);
}

/**
 * Forget a tunnel: the record AND its socket.
 *
 * The socket is not incidental cleanup. A unix socket left behind by a dead
 * process is a path that still exists, so a `connect` against it fails in its
 * own way rather than looking like absence — and one left behind by a tunnel
 * that has gone is indistinguishable from one belonging to a tunnel that is
 * merely slow. Removing both together keeps "no tunnel" a single state.
 */
export async function removeTunnelState(dir: string): Promise<void> {
  await rm(tunnelStateFile(dir), { force: true });
  await rm(controlSocket(dir), { force: true });
}

export interface RecordTunnelDeps {
  capture?: (pid: number) => string | null;
  probe?: Probe;
  warn?: (line: string) => void;
}

/**
 * Record a running tunnel, or explain why it was not.
 *
 * NEVER THROWS, for the same reason `recordState` never does: the published
 * tunnel is the product, and `pair` and `status` are conveniences on top of
 * it. Neither an unwritable config dir nor an unreadable command line may take
 * down a tunnel that is already carrying traffic.
 *
 * FIRST TUNNEL WINS, the same rule and for the same reason as `recordState`'s.
 * `--detach` refuses before it spawns when one is already recorded, so this
 * guard is the backstop for the paths that cannot check first — two foreground
 * `--publish-running` runs, say. Overwriting would leave the first tunnel
 * unfindable by `pair` for the rest of its life while its URL kept working,
 * which is the mis-tracking that rule exists to prevent.
 */
export async function recordTunnel(
  dir: string,
  s: Omit<TunnelState, "args">,
  deps: RecordTunnelDeps = {},
): Promise<boolean> {
  const capture = deps.capture ?? capturedArgs;
  const warn = deps.warn ?? termWarn;

  try {
    const held = await checkTunnelState(dir, deps.probe ?? systemProbe, warn);
    if (held.kind === "running" && held.state.pid !== s.pid) {
      warn(
        `paddock: pid ${held.state.pid} is already recorded as the tunnel for ` +
          `${held.state.url} — not recording pid ${s.pid} over it, so \`paddock pair\` ` +
          "will keep pointing at the older one",
      );
      return false;
    }
  } catch (e) {
    // "Cannot tell who holds the record" is answered as a conflict, not a free
    // pass — the same call this makes as `recordState`. `checkRecord` reaches
    // for `ps` where /proc does not exist, and that throws when `ps` is absent.
    warn(
      `paddock: could not check for a tunnel already recorded in ${dir} (${String(e)}) — ` +
        `not recording pid ${s.pid}, so \`paddock pair\` will not find it`,
    );
    return false;
  }

  let args: string | null;
  try {
    args = capture(s.pid);
  } catch (e) {
    warn(
      `paddock: could not read pid ${s.pid}'s own command line (${String(e)}) — ` +
        "not recording the tunnel, so `paddock pair` will not find it",
    );
    return false;
  }
  if (args === null) {
    warn(
      `paddock: could not read pid ${s.pid}'s own command line — not recording the ` +
        "tunnel, so `paddock pair` will not find it",
    );
    return false;
  }

  try {
    await writeTunnelState(dir, { ...s, args });
    return true;
  } catch (e) {
    warn(
      `paddock: could not record the tunnel (${String(e)}) — \`paddock pair\` and ` +
        "`paddock stop` will not find it",
    );
    return false;
  }
}
