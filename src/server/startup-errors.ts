import { statSync, type Stats } from "node:fs";

/**
 * What the operator is told when paddock cannot start at all.
 *
 * Both conditions here are ordinary — a port already taken, herdr not running
 * yet — and both used to answer with an unhandled throw: bundler frames, a
 * `syscall`, an `errno`, and (in a compiled binary) a `/$bunfs/root/paddock`
 * path that exists on no filesystem. For someone who has just installed
 * paddock, that trace is the entire product.
 *
 * The message builders are pure: they are the part worth asserting, and they
 * must not need a bound port or a live herdr to test.
 */

/** The `code` on a node/bun errno error, when there is one. */
export function errorCode(err: unknown): string | null {
  const c = (err as NodeJS.ErrnoException | null)?.code;
  return typeof c === "string" ? c : null;
}

export function portInUseMessage(port: number, hostname: string): string {
  // Deliberately does not claim to know WHAT holds the port. Usually it is
  // another paddock; it is just as legitimately anything else, and a message
  // that guesses wrong sends the operator hunting for the wrong process.
  return [
    `paddock: port ${port} is already in use`,
    `  something is already listening on ${hostname}:${port}`,
    `  stop whatever holds it, or choose another port: PADDOCK_PORT=${port + 1} paddock`,
  ].join("\n");
}

export type SocketPathKind =
  "missing" | "not-a-socket" | "socket" | "unreadable";

/**
 * What is actually at the socket path — asked of the filesystem, not inferred
 * from the connect error.
 *
 * Measured: Bun reports ENOENT when connecting to a path that exists but is a
 * regular file, so the connect error alone cannot tell "herdr is not running"
 * from "that is the wrong path". Telling the second operator to start herdr
 * sends them to fix a problem they do not have.
 */
export function inspectSocketPath(
  path: string,
  stat: (p: string) => Stats = statSync,
): SocketPathKind {
  try {
    return stat(path).isSocket() ? "socket" : "not-a-socket";
  } catch (e) {
    // ENOENT is an answer, not a failure to get one. Any other errno means we
    // could not look, which must not be reported as "it is not there".
    if (errorCode(e) === "ENOENT") return "missing";
    return "unreadable";
  }
}

/**
 * Is this failure one we can actually diagnose?
 *
 * Only two things qualify: a filesystem fact about the socket path, and an
 * errno-shaped I/O failure. Everything else — a parse bug, or one of
 * herdr/socket.ts's own errors, which already read as sentences that name
 * herdr and the method that failed — is printed as it is, with its stack.
 *
 * Replacing a bug's stack trace with "no herdr socket at ..." would send the
 * reader off to check whether herdr is running when the fault is in paddock.
 * Same reasoning as catching EADDRINUSE and rethrowing every other bind
 * failure: format what is recognised, never everything.
 */
export function isDiagnosableHerdrFailure(
  err: unknown,
  kind: SocketPathKind,
): boolean {
  return (
    kind === "missing" || kind === "not-a-socket" || errorCode(err) !== null
  );
}

export function herdrUnreachableMessage(
  socketPath: string,
  err: unknown,
  kind: SocketPathKind,
): string {
  const code = errorCode(err);
  const detail = code ? ` (${code})` : "";
  const head: string[] = {
    missing: [
      `paddock: no herdr socket at ${socketPath}`,
      "  paddock reads herdr over that socket — start herdr first, then run paddock again",
    ],
    "not-a-socket": [
      `paddock: ${socketPath} exists, but it is not a socket`,
      "  that is almost certainly the wrong path — herdr's socket is usually at",
      "  ~/.config/herdr/herdr.sock",
    ],
    socket: [
      `paddock: no usable answer from the herdr socket at ${socketPath}${detail}`,
      "  the socket is there but nothing is serving it — is herdr still running?",
    ],
    unreadable: [
      `paddock: cannot reach herdr at ${socketPath}${detail}`,
      "  the path could not be examined — check its permissions",
    ],
  }[kind];

  return [
    ...head,
    `  a herdr somewhere else: PADDOCK_HERDR_SOCKET=/path/to/herdr.sock`,
    "  no herdr at all: 'paddock --demo' runs with synthetic agents",
  ].join("\n");
}
