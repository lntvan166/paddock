import { qrMatrix } from "@server/qr";
import { duration, glyph, say } from "@server/term";
import { askControl, type Ask } from "@server/tunnel/control";
import { qrLines } from "@server/tunnel/display";
import { formatCode } from "@server/tunnel/pairing";
import { wantsQr } from "@server/tunnel/run";
import { checkTunnelState, removeTunnelState } from "@server/tunnel/state";
import type { Probe } from "@server/lifecycle/state";

export interface PairOpts {
  dir: string;
  probe?: Probe;
  log?: (line: string) => void;
  /** Injected so a test never needs a real socket. */
  ask?: (socket: string) => Promise<Ask>;
  now?: () => number;
  colour?: boolean;
  columns?: number;
  rows?: number;
}

/**
 * `paddock pair` — get a phone onto the tunnel that is already running.
 *
 * The command a detached tunnel needs to exist. Foreground, the display loop
 * shows the URL, the code and the QR and keeps them current; detached, nothing
 * draws and nothing advances the code. This asks the running tunnel instead,
 * over its control socket, which makes the answer live rather than remembered
 * — and mints, so the code printed here always has its full TTL ahead of it.
 *
 * Works identically against a FOREGROUND tunnel, which serves the same socket.
 * That is not a side effect worth hiding: an operator whose terminal has
 * scrolled past the code should not have to restart a tunnel to read it again.
 */
export async function runPair(o: PairOpts): Promise<number> {
  const log = o.log ?? say;
  const ask = o.ask ?? askControl;
  const now = (o.now ?? Date.now)();

  const got = await checkTunnelState(o.dir, o.probe, log);
  switch (got.kind) {
    case "none":
      log(`${glyph("no")} no tunnel is running`);
      log("    `paddock tunnel --detach` starts one and returns your shell");
      return 1;
    case "unreadable":
      // "Could not tell" is not "nothing running", and the file is left alone:
      // it is the only clue an operator has and we could not even read it.
      log(`${glyph("unknown")} could not read the tunnel's state (${got.error})`);
      return 1;
    case "stale":
      log(`${glyph("no")} no tunnel is running (stale record for pid ${got.state.pid}, cleared)`);
      await removeTunnelState(o.dir);
      return 1;
    case "mismatch":
      log(
        `${glyph("no")} no tunnel is running (pid ${got.state.pid} is now: ` +
          `${got.actual ?? "unknown"})`,
      );
      await removeTunnelState(o.dir);
      return 1;
    case "running":
      break;
    default: {
      // Exhaustiveness guard, matching `runStatus`: a sixth `Check` variant
      // added later must be a compile error here rather than falling through
      // to "no tunnel" for a case nobody considered.
      const _exhaustive: never = got;
      throw new Error(`paddock: unhandled tunnel state: ${JSON.stringify(_exhaustive)}`);
    }
  }

  const answer = await ask(got.state.control);
  if (!answer.ok) {
    // NOT "no tunnel is running". The record says one is, and told otherwise
    // an operator starts a second tunnel beside the first — which is precisely
    // the two-notifier failure `preflight` exists to prevent.
    log(`${glyph("unknown")} the tunnel (pid ${got.state.pid}) is not answering on its control socket`);
    log(`    ${got.state.control} — ${answer.detail}`);
    log("    it may be shutting down; `paddock stop` then start it again");
    return 1;
  }

  const colour = o.colour ?? false;
  const columns = o.columns ?? 0;
  const rows = o.rows ?? 0;

  log(`${glyph("yes")} tunnel — ${answer.answer.url}`);
  const left = answer.answer.expiresAt - now;
  log(
    `    code ${formatCode(answer.answer.code)}` +
      (left > 0 ? ` · expires in ${duration(left)}` : " · expired, ask again"),
  );
  if (got.state.publishing !== null) {
    log(`    publishing the paddock on port ${got.state.publishing}`);
  }

  // The SAME payload the foreground display encodes, built here rather than
  // borrowed, because the fragment is the whole reason a code may travel in a
  // URL: it is never sent to a server and so reaches no access log. A query
  // string here would put the pairing code into Cloudflare's edge logs. See
  // docs/decisions.md decision 22.
  const target = `${answer.answer.url}/#${answer.answer.code}`;
  log(`    ${target}`);
  if (wantsQr({ colour, columns, rows })) {
    log("");
    for (const line of qrLines(qrMatrix(target), colour)) log(line);
  }
  return 0;
}
