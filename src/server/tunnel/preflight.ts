import { checkState, type StateCheck } from "@server/lifecycle/state";
import { isConfigured } from "@server/settings/store";
import { findCloudflared, installHint } from "@server/tunnel/cloudflared";
import { isQuickTunnelUrl } from "@shared/quick-tunnel";
import { warn } from "@server/term";

export type Preflight = { ok: true; bin: string } | { ok: false; message: string };

/**
 * The three refusals, cheapest first, and NOTHING bound or opened until all
 * three pass — the rule `index.ts` already follows for `help` / `update` /
 * `status`. A command that is going to fail must not start a server on its way
 * to failing.
 *
 * Order matters beyond cost: a running instance is reported before a missing
 * binary, because being told to install cloudflared and only then told to stop
 * paddock is two trips for one answer.
 */
export async function preflight(opts: {
  dir: string;
  platform?: string;
  which?: (bin: string) => string | null;
  check?: (dir: string) => Promise<StateCheck>;
  log?: (line: string) => void;
  /**
   * Publishing a paddock that is already running, where that instance is the
   * POINT rather than the problem.
   *
   * The refusal below exists because `paddock tunnel` is a whole second
   * paddock — its own herdr stream, its own notifier, two notifications per
   * agent. A publishing run builds none of those and proxies to the instance it
   * found, so the reason does not apply and the check is skipped.
   *
   * Only this check. cloudflared still has to exist, and everything after this
   * runs unchanged.
   */
  publishRunning?: boolean;
}): Promise<Preflight> {
  const platform = opts.platform ?? process.platform;
  const check = opts.check ?? ((d: string) => checkState(d));
  const log = opts.log ?? warn;

  const state = await check(opts.dir);
  if (state.kind === "running" && opts.publishRunning !== true) {
    return {
      ok: false,
      message: [
        // "another", not "a detached": this is `checkState`, and `index.ts`
        // records state for FOREGROUND runs too, so the instance found here is
        // just as likely to be a `paddock` in the next terminal. Told
        // "detached", that operator concludes the message is about something
        // else and goes looking for a process they never started — while the
        // remedy printed below works for their foreground one as it stands.
        `paddock: another paddock is already running (pid ${state.state.pid})`,
        "",
        "  `paddock tunnel` serves the dashboard itself, so running it alongside",
        "  that instance would open a SECOND connection to herdr — and a second",
        "  notifier. Every blocked agent would notify you twice.",
        "",
        "    `paddock stop && paddock tunnel`",
        "",
        "  or publish the one already running, without stopping it — this adds",
        "  no second herdr connection and no second notifier:",
        "",
        "    `paddock tunnel --publish-running`",
      ].join("\n"),
    };
  }
  // Never swallowed: a state file we could not read is reported, then stepped
  // past. It is not evidence that anything is running.
  if (state.kind === "unreadable") {
    log(`paddock: could not read the state file (${state.error}); continuing`);
  }

  const bin = findCloudflared(opts.which);
  if (bin === null) {
    return {
      ok: false,
      message: [
        "paddock: cloudflared is not installed",
        "",
        "  `paddock tunnel` needs Cloudflare's tunnel client to publish a URL.",
        "",
        installHint(platform),
        "",
        "  then run `paddock tunnel` again.",
      ].join("\n"),
    };
  }

  return { ok: true, bin };
}

/**
 * The one-line nudge printed by `paddock` and `paddock start`, or null.
 *
 * Silent when `publicUrl` names a real deployment: that operator is on the
 * named-tunnel path with Access in front of it, which is the RECOMMENDED
 * deployment, and nudging them toward a quick tunnel would advertise the weaker
 * option to the one person who does not need it.
 *
 * But a SAVED `*.trycloudflare.com` value is not a deployment — the hostname
 * changes on every start, so it is a dead link from an earlier run, and its
 * owner is precisely who this hint is for. "Configured" therefore means set AND
 * not a quick tunnel.
 *
 * `isConfigured` rather than a local truthiness test — four call sites once
 * disagreed about an empty-string token, and this is not becoming the fifth.
 */
export function tunnelHint(publicUrl: string | null, detached: boolean): string | null {
  if (isConfigured(publicUrl) && !isQuickTunnelUrl(publicUrl)) return null;
  return detached
    ? "  for phone access, stop it and run `paddock tunnel`"
    : "  to reach this from your phone: `paddock tunnel`";
}
