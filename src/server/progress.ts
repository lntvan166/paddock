import { bar } from "@server/term";

/**
 * The ONLY code in this repository that redraws a line.
 *
 * It is a separate file rather than part of `term.ts` because `term.ts` is a
 * dependency-free LEAF whose whole value is that its functions are pure and
 * assertable with no tty — see its header comment and the dependency direction
 * in docs/architecture.md. Terminal width, `\r`, throttling and tty detection
 * are the opposite of that, and putting them there would make
 * `herdr/socket.ts` transitively depend on a progress bar.
 *
 * The interface is injected into `runUpdate` the way `log` already is, so no
 * test needs a pty to drive an update.
 */
export interface Progress {
  /** `total` is null when the server sent no `content-length`. */
  start(label: string, total: number | null): void;
  advance(bytes: number): void;
  /** Leaves the cursor at the start of a clean line. */
  done(): void;
}

const MB = 1_048_576;
const mb = (n: number) => Math.round(n / MB);

/**
 * Ten redraws a second, no more. An 83 MB download arrives in far more chunks
 * than that, and a redraw per chunk is a write syscall per chunk for motion no
 * eye can follow.
 */
const REDRAW_MS = 100;

/** The widest bar worth drawing, however wide the terminal is. */
const MAX_BAR = 40;

/**
 * A pipe, a CI log, a file. One line when the download starts and nothing
 * after — the same information the bar carries, minus the motion a log cannot
 * show.
 */
export function lineProgress(log: (s: string) => void): Progress {
  return {
    start(label, total) {
      log(
        total === null
          ? `paddock: downloading ${label}`
          : `paddock: downloading ${label} (${mb(total)} MB)`,
      );
    },
    advance() {},
    done() {},
  };
}

export interface BarOpts {
  write: (s: string) => void;
  /** Read PER REDRAW, never captured: a terminal can be resized mid-download. */
  columns: () => number;
  now: () => number;
}

export function barProgress(o: BarOpts): Progress {
  let total: number | null = null;
  let seen = 0;
  let startedAt = 0;
  let lastDraw = 0;
  let last = "";
  let live = false;

  const frame = (): string => {
    const secs = Math.max(0.001, (o.now() - startedAt) / 1000);
    const rate = `${(seen / MB / secs).toFixed(1)} MB/s`;
    if (total === null) return `  ${mb(seen)} MB  ${rate}`;
    const pct = `${Math.floor((seen / total) * 100)}%`.padStart(4);
    const counts = `${mb(seen)}/${mb(total)} MB`;
    // Whatever is left after the text, capped. `bar` returns "" when that is
    // too narrow to mean anything, and the percentage stands on its own.
    const room = o.columns() - (pct.length + counts.length + rate.length + 8);
    const b = bar(seen / total, Math.min(MAX_BAR, room));
    return `  ${b}${b === "" ? "" : "  "}${pct}  ${counts}  ${rate}`;
  };

  const draw = (force: boolean): void => {
    const t = o.now();
    if (!force && t - lastDraw < REDRAW_MS) return;
    const s = frame();
    if (s === last) return;
    lastDraw = t;
    // A cheap guard, not a load-bearing one: the rate moves with the clock, so
    // two frames are rarely byte-identical in practice. It costs one string
    // compare and saves a write on the occasions they are.
    last = s;
    live = true;
    // `\r` then erase-to-end-of-line: a shorter frame after a longer one must
    // not leave the tail of the longer one behind.
    o.write(`\r\x1b[2K${s}`);
  };

  return {
    start(_label, t) {
      total = t;
      seen = 0;
      startedAt = o.now();
      lastDraw = 0;
      last = "";
      draw(true);
    },
    advance(n) {
      seen += n;
      draw(false);
    },
    done() {
      // Erase, do NOT newline. The caller's next `log` line is the one the
      // operator keeps; the bar was scaffolding.
      if (live) {
        o.write("\r\x1b[2K");
        live = false;
      }
    },
  };
}

export interface MakeProgressOpts {
  log: (s: string) => void;
  env: Record<string, string | undefined>;
  stream: { isTTY?: boolean; columns?: number; write: (s: string) => void };
  now?: () => number;
}

/**
 * Bar on a tty, lines everywhere else.
 *
 * `NO_COLOR` suppresses the bar as well as the colour. Strictly the variable
 * governs colour and an uncoloured bar would be defensible — but a redrawn
 * line is motion, the environments that set `NO_COLOR` are overwhelmingly the
 * ones capturing output to a file, and one switch covering both is one thing
 * to reason about rather than two.
 */
export function makeProgress(o: MakeProgressOpts): Progress {
  if (o.stream.isTTY !== true || "NO_COLOR" in o.env) return lineProgress(o.log);
  return barProgress({
    write: (s) => o.stream.write(s),
    columns: () => o.stream.columns ?? 80,
    now: o.now ?? Date.now,
  });
}
