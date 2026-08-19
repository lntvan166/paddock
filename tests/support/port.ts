/**
 * A TCP port the OS has just confirmed is free.
 *
 * Extracted from `tests/embedded.test.ts`, which had the only correct version
 * of this in the tree while three other tests guessed instead — and guessing
 * is what produced two separate flakes on one branch. The first picked from
 * 9060-9099, which contains paddock's own default port, so `make test` failed
 * roughly one run in twenty on the machine of anyone actually running paddock;
 * the failure looked like an unrelated timer flake and cost a 48-run stress
 * hunt to identify. The second picked from 8930-9049 on a box with a listener
 * on 9000, and bit while the first was being written up.
 *
 * A range that "looks unused" is a guess about someone else's machine. Asking
 * the OS is not.
 *
 * There is still a window between this returning and the caller binding, so
 * this is not a guarantee — it is the difference between racing every process
 * on the machine and racing only whatever binds in the next few milliseconds.
 * No test here can close that window, because the port has to be handed to a
 * child process as a number.
 */
export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  // Optional on the type because a Server can be bound to a unix socket
  // instead; this one asked for TCP, so a missing port is a broken assumption
  // rather than something to paper over with a fallback number.
  if (port === undefined) throw new Error("probe server bound no TCP port");
  return port;
}
