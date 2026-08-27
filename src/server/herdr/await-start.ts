import { backoffWithJitter } from "@server/herdr/keeper";
import { ProtocolMismatchError } from "@server/herdr/socket";
import {
  inspectSocketPath,
  isDiagnosableHerdrFailure,
  type SocketPathKind,
} from "@server/startup-errors";

/**
 * Waiting for herdr at startup, bounded.
 *
 * WHY THIS EXISTS. `index.ts` used to wrap `checkProtocol()` and
 * `supervisor.start()` in one `try` and `process.exit(1)` for anything either
 * threw — so a herdr that simply was not up YET died exactly like a herdr
 * answering with an incompatible protocol. `keeper.ts`'s jittered-backoff
 * reconnect only arms after `supervisor.start()` has succeeded once, so it
 * never got a chance to cover the startup case. A paddock started before herdr
 * — an ordering `systemd`, Docker Compose or a plain reboot cannot promise —
 * therefore died instead of waiting. Docker was the one covered path, because
 * `docker-compose.yml` sets `restart: unless-stopped`; the bare binary, which
 * ships no unit file, stayed dead.
 *
 * WHY IT IS BOUNDED rather than infinite. Today's refusal is deliberate and
 * good for someone at a terminal: `herdrUnreachableMessage` tells them to start
 * herdr and run paddock again. Retrying forever would turn a mistyped
 * `PADDOCK_HERDR_SOCKET` into a process that hangs with no output instead of a
 * message naming the path. A bounded wait keeps the boot race survivable and
 * still refuses loudly when herdr is genuinely not coming.
 *
 * WHAT IS RETRIED is the load-bearing decision here, not the loop: only
 * failures that TIME can fix. See `isWaitable`.
 *
 * This module holds no state and opens nothing. Every dependency — the clock,
 * the sleep, the backoff, the filesystem probe, and the connect itself — is
 * injectable, so `tests/herdr-await-start.test.ts` drives the whole policy
 * without a socket, a real delay, or booting `Bun.serve`.
 */

/**
 * The two path states worth waiting on. Named because the message builder
 * accepts only these — see `herdrWaitingMessage`.
 */
export type WaitablePathKind = Extract<SocketPathKind, "missing" | "socket">;

/** How long a paddock started before herdr waits for it. */
export const DEFAULT_WAIT_MS = 60_000;

/**
 * The wait budget, from the environment.
 *
 * The seam exists because the real startup path can only be exercised by
 * SPAWNING paddock — `tests/startup-errors.test.ts` runs the server to assert
 * what an operator is told — and a spawned process cannot be handed an
 * injected budget. `PADDOCK_HERDR_WAIT_MS=0` restores the immediate refusal,
 * which is what those tests want and what an operator who prefers the old
 * behaviour can set.
 *
 * Anything unusable falls back to the DEFAULT, never to 0. Same reasoning as
 * `resolveHost` treating an empty value as unset: a half-written env line must
 * not silently change behaviour, and here falling back to no wait would
 * quietly restore the very failure this module exists to fix.
 */
export function resolveWaitMs(env: Record<string, string | undefined>): number {
  const raw = env.PADDOCK_HERDR_WAIT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_WAIT_MS;
  // Digits only: `Number()` accepts "1e3", " 12 " and "0x10", and parseInt
  // accepts "12abc". Neither is something an operator meant to write.
  if (!/^\d+$/.test(raw)) return DEFAULT_WAIT_MS;
  return Number(raw);
}

export type StartOutcome =
  /** herdr answered. `protocol` is what `connect` resolved. */
  | { kind: "ready"; protocol: number }
  /** Waiting cannot help. Report and exit, exactly as before this module. */
  | { kind: "fatal"; err: unknown; pathKind: SocketPathKind }
  /** herdr never appeared inside the budget. Report and exit. */
  | {
      kind: "gaveUp";
      err: unknown;
      pathKind: SocketPathKind;
      waitedMs: number;
      attempts: number;
    };

export interface ConnectWithWaitOptions {
  /** Where herdr's socket should be. Reported, and probed on failure. */
  socketPath: string;
  /**
   * Connect and reconcile — in `index.ts`, `checkProtocol()` plus
   * `supervisor.start()` — resolving the protocol number to run with.
   *
   * Safe to call again after it throws, which is what the retry does:
   * `start()` is `reconcile()` then `resubscribe()` then `setInterval`, so a
   * throw from either await leaves no healing timer behind, and
   * `resubscribe()` records its subscription key only after a successful open.
   */
  connect: () => Promise<number>;
  budgetMs?: number;
  backoff?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** What is at the socket path. Injected so a test needs no socket. */
  inspect?: (path: string) => SocketPathKind;
  /**
   * Called ONCE, on the first failure worth waiting on — not per attempt. An
   * operator needs to know why paddock has not come up yet; they do not need
   * the same paragraph six times, and a per-attempt log would bury the message
   * that actually matters if the wait then fails.
   */
  onWaiting?: (err: unknown, pathKind: WaitablePathKind) => void;
}

/**
 * Can time fix this?
 *
 * Retried: a MISSING socket (herdr has not created it yet) and an errno
 * failure against a socket that IS there (herdr bound it but is not serving
 * yet, or a stale socket from a dead herdr is about to be replaced).
 *
 * Never retried:
 * - `ProtocolMismatchError` — the keeper's own rule. A live herdr gave a real
 *   answer, and it will give the same one in 60 seconds.
 * - `not-a-socket` — a regular file at that path will not become a socket.
 *   This is the wrong-path case, and the operator needs to be told now.
 * - `unreadable` — permissions do not heal on their own.
 * - Anything paddock cannot diagnose: no errno, against a socket that is fine.
 *   That is a paddock bug or a herdr error that already reads as a sentence,
 *   and burying it for a minute before reporting "herdr never appeared" would
 *   describe the wrong problem. It keeps today's behaviour: print it, with its
 *   stack, immediately.
 */
function isWaitable(err: unknown, pathKind: SocketPathKind): boolean {
  if (err instanceof ProtocolMismatchError) return false;
  if (pathKind === "not-a-socket" || pathKind === "unreadable") return false;
  return isDiagnosableHerdrFailure(err, pathKind);
}

export async function connectWithWait(
  opts: ConnectWithWaitOptions,
): Promise<StartOutcome> {
  const budgetMs = opts.budgetMs ?? DEFAULT_WAIT_MS;
  const backoff = opts.backoff ?? backoffWithJitter;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? Date.now;
  const inspect = opts.inspect ?? inspectSocketPath;

  const startedAt = now();
  let announced = false;

  for (let attempt = 0; ; attempt++) {
    try {
      return { kind: "ready", protocol: await opts.connect() };
    } catch (err) {
      // Asked of the filesystem at the moment of failure, not cached from
      // before the attempt: the whole point is that the socket may appear
      // while paddock is waiting, and it may also be replaced mid-wait.
      const pathKind = inspect(opts.socketPath);
      if (!isWaitable(err, pathKind)) return { kind: "fatal", err, pathKind };

      const waitedMs = now() - startedAt;
      const delay = backoff(attempt);
      // A delay that would overshoot ends the wait instead of being slept:
      // "bounded" is what the operator was promised, so overshooting it by
      // most of another backoff window is not a rounding difference.
      if (waitedMs + delay > budgetMs) {
        return { kind: "gaveUp", err, pathKind, waitedMs, attempts: attempt + 1 };
      }

      if (!announced) {
        announced = true;
        // Restated rather than cast: `isWaitable` has already excluded the
        // other two kinds, and the message builder takes only these by design.
        if (pathKind === "missing" || pathKind === "socket") {
          opts.onWaiting?.(err, pathKind);
        }
      }
      await sleep(delay);
    }
  }
}
