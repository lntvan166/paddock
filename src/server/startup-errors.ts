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
    `  stop whatever holds it, or choose another port: \`PADDOCK_PORT=${port + 1} paddock\``,
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
      "  `~/.config/herdr/herdr.sock`",
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
    `  a herdr somewhere else: \`PADDOCK_HERDR_SOCKET=/path/to/herdr.sock\``,
    "  no herdr at all: `paddock --demo` runs with synthetic agents",
  ].join("\n");
}

/**
 * What the operator is told while paddock WAITS for herdr, rather than
 * refusing to start without it.
 *
 * Separate from `herdrUnreachableMessage` because that message ends by telling
 * the operator to start herdr and run paddock again. That is correct advice
 * from a process that is about to exit and wrong from one that is waiting:
 * nothing needs re-running, and an operator who follows it kills a paddock
 * that was seconds from coming up.
 *
 * Only the two waitable kinds are accepted. `not-a-socket` and `unreadable`
 * are never waited on (see `herdr/await-start.ts`), so passing one here is a
 * compile error rather than a message that would claim paddock is waiting for
 * something it has already given up on.
 */
export function herdrWaitingMessage(
  socketPath: string,
  kind: Extract<SocketPathKind, "missing" | "socket">,
  budgetMs: number,
): string {
  const seconds = Math.round(budgetMs / 1000);
  const head: string[] = {
    missing: [
      `paddock: no herdr socket at ${socketPath} yet — waiting up to ${seconds}s`,
      "  paddock reads herdr over that socket, and starts as soon as herdr creates it",
    ],
    socket: [
      `paddock: nothing is answering the herdr socket at ${socketPath} yet — waiting up to ${seconds}s`,
      "  the socket is there, so herdr is either still starting or has just stopped",
    ],
  }[kind];

  return [
    ...head,
    "  if herdr does not appear, paddock reports that and exits rather than waiting on",
    "  a herdr that is not coming",
  ].join("\n");
}

/**
 * The line that precedes the ordinary unreachable message when a bounded wait
 * ran out.
 *
 * Worth a line of its own because the message that follows — "start herdr
 * first, then run paddock again" — reads, on its own, like paddock never
 * tried. An operator who has just watched a supervised paddock exit needs to
 * know the difference between "it refused immediately" and "it waited a minute
 * and herdr never came", because those point at different problems: the first
 * at the socket path, the second at whatever should have started herdr.
 */
export function herdrNeverAppearedMessage(
  waitedMs: number,
  attempts: number,
): string {
  // Sub-second in ms: "waited 0s" reads as "did not wait", which is the one
  // thing this line exists to deny. Only reachable with a small configured
  // budget, which is what the tests use.
  const spent = waitedMs < 1000 ? `${waitedMs}ms` : `${Math.round(waitedMs / 1000)}s`;
  const tries = attempts === 1 ? "1 attempt" : `${attempts} attempts`;
  return `paddock: waited ${spent} for herdr over ${tries}, and it did not appear`;
}

/**
 * Where the listener BINDS, and what the operator is told when that is not
 * loopback.
 *
 * This is a different question from the one `origin.ts` answers, and the two
 * must not share a predicate. `origin.ts` classifies `Host` HEADERS, which name
 * one machine and are never wildcards. A bind address can be `0.0.0.0` or `::`,
 * which name every interface at once — the case that matters here and the case
 * a `Host` header cannot express.
 *
 * WHY THE DEFAULT MUST STAY LOOPBACK. `docs/decisions.md` decision 3 gives this
 * listener no authentication of its own, deliberately, and the same-origin gate
 * in `origin.ts` says so in as many words: it is a CSRF control, not an
 * authenticator. So reachability IS authority here — anything that can open the
 * port can read every agent's screen and type into it. Loopback is what makes
 * that acceptable, which is why the override exists but announces itself.
 */

/** Bind addresses that name only this machine, other than the `127.0.0.0/8` block. */
const LOOPBACK_BINDS: readonly string[] = ["localhost", "::1", "[::1]"];

/** Bind addresses that mean "every interface". */
const WILDCARD_BINDS: readonly string[] = ["0.0.0.0", "::", "[::]"];

/**
 * The address to bind, from the environment.
 *
 * An empty or whitespace-only value is treated as UNSET rather than as a
 * wildcard. `PADDOCK_HOST:` with nothing after it in a compose file, and
 * `PADDOCK_HOST=` in an `.env`, both arrive here as `""` — and resolving that
 * to `0.0.0.0` would silently publish an unauthenticated dashboard because
 * somebody left a line half-written.
 */
export function resolveHost(env: Record<string, string | undefined>): string {
  const value = env.PADDOCK_HOST?.trim();
  return value === undefined || value === "" ? "127.0.0.1" : value;
}

/** Whether a bind address reaches only this machine. */
export function isLoopbackBind(host: string): boolean {
  const name = host.trim().toLowerCase();
  if (LOOPBACK_BINDS.includes(name)) return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1 — a resolver stub on
  // 127.0.0.53 is loopback too, and warning about it would be noise.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/** Whether a bind address names every interface. */
function isWildcardBind(host: string): boolean {
  return WILDCARD_BINDS.includes(host.trim().toLowerCase());
}

/**
 * What the operator is told when the bind is not loopback, or `null` when it is.
 *
 * Not an error: a container REQUIRES a non-loopback bind, because published
 * ports are delivered to the container's own interface and a loopback listener
 * refuses them. So this warns and proceeds. It names the address and port
 * literally, because the failure it is trying to prevent is someone believing
 * this is still a private dashboard.
 */
export function nonLoopbackBindWarning(host: string, port: number): string | null {
  if (isLoopbackBind(host)) return null;
  return [
    `paddock: bound to ${host}:${port} — not loopback`,
    "  every host that can reach this port has full control of your agents:",
    "  it can read their screens and type into them. paddock has",
    "  no authentication of its own (docs/decisions.md decision 3).",
    "  In a container this is expected — keep the published port on 127.0.0.1.",
    "  On a desk it means your network can drive your agents.",
  ].join("\n");
}

/**
 * The banner line naming where the dashboard is.
 *
 * A wildcard bind gets a loopback URL plus the fact of the wildcard, never
 * `http://0.0.0.0:8787` — that string looks like a link, and it is not one any
 * browser can open. The banner's only job is to be clickable.
 */
export function listeningLine(host: string, port: number): string {
  if (isWildcardBind(host)) {
    return `  paddock  \`http://127.0.0.1:${port}\`  (all interfaces, port ${port})`;
  }
  return `  paddock  \`http://${host}:${port}\``;
}
