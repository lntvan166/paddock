/**
 * Ordered writes to a Bun socket that never lose a tail.
 *
 * Bun's `socket.write` writes what fits in the kernel buffer and RETURNS the
 * count; the rest is the caller's to write on `drain`. paddock's socket writers
 * ignored that count, so any message larger than the buffer was cut short
 * and the core waited forever for the rest of its line: measured as
 * `terminal.put` of a 179 KB screenshot (240 KB of base64 in one JSON line)
 * timing out, while `hc put` of the same file returned at once. A long
 * paste through a typing attach had the same exposure.
 */
export function socketWriter() {
  let sock: { write(data: Uint8Array): number } | null = null;
  const pending: Uint8Array[] = [];
  const flush = () => {
    while (sock && pending.length > 0) {
      const head = pending[0]!;
      const n = sock.write(head);
      if (n < head.length) {
        pending[0] = head.subarray(Math.max(n, 0));
        return; // the rest goes on `drain`
      }
      pending.shift();
    }
  };
  return {
    attach(s: { write(data: Uint8Array): number }) { sock = s; flush(); },
    write(data: Uint8Array) { pending.push(data); flush(); },
    /** Call from the socket's `drain` handler. */
    drain: flush,
    /** Bytes accepted but not yet handed to the socket (for tests). */
    queued: () => pending.reduce((n, p) => n + p.length, 0),
  };
}

