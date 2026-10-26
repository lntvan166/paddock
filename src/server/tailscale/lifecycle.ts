/**
 * How `status`, `stop` and `local` keep Tailscale in step with the service.
 *
 * `stop` removes paddock's `tailscale serve` config but leaves `tailscale.json`,
 * so `local` can put the same URL back; only `paddock tailscale off` clears the
 * setting. None of these ever change their command's exit code: Tailscale is
 * an extra way in, and 8787 is the product. Every failure is still said.
 *
 * Kept apart from `lifecycle/commands.ts` so that file never imports
 * `tailscale/command.ts`, which imports it.
 */

import { existsSync } from "node:fs";
import { spawnRun } from "@server/lifecycle/service/run";
import type { Run } from "@server/lifecycle/service/types";
import { findTailscale, ownsServe, serveOff, serveOn, servedTarget } from "@server/tailscale/cli";
import { readTailscaleConfig, tailnetPortFrom, tailscaleConfigFile } from "@server/tailscale/config";
import { isTailnetRefusal } from "@server/tailscale/gate";
import { glyph } from "@server/term";

/** Injected through `StatusOpts`, `StopOpts` and `LocalOpts`. */
export interface TailscaleHooks {
  /** The tailnet listener's port; defaults to `PADDOCK_TAILNET_PORT` or 8789. */
  tailnetPort?: number;
  run?: Run;
  find?: () => string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function resolve(o: TailscaleHooks) {
  return {
    port: o.tailnetPort ?? tailnetPortFrom(process.env),
    run: o.run ?? spawnRun,
    find: o.find ?? (() => findTailscale()),
  };
}

/**
 * Whether the tailnet listener is up: `true`, or why not.
 *
 * Up means paddock's identity gate refused this identity-less request — a 200
 * would be something else on the port, since the real listener admits no
 * request without a Tailscale identity. Bounded, so a port that accepts and
 * never answers cannot hang `status`.
 */
export async function tailnetHealth(
  port: number,
  f: typeof fetch = fetch,
  timeoutMs = 1_500,
): Promise<true | string> {
  const where = `127.0.0.1:${port}`;
  let res: Response;
  try {
    res = await f(`http://${where}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return `nothing answers on ${where}: ${message(e)}`;
  }
  const text = await res.text().catch((e) => `<unreadable body: ${message(e)}>`);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON is an answer in itself; described below with the status.
  }
  if (res.status === 403 && isTailnetRefusal(body)) return true;
  return `${where} answered HTTP ${res.status}, not paddock's tailnet gate`;
}

/**
 * The tailscale block of `paddock status`. Silent without a config, for the
 * reason `reportTunnel` is: most machines have none.
 */
export async function reportTailscale(
  o: { dir: string; tailnetHealth?: (port: number) => Promise<true | string> } & TailscaleHooks,
  log: (line: string) => void,
): Promise<void> {
  const cfg = await readTailscaleConfig(o.dir, log);
  if (cfg === null) return;
  const { port, run, find } = resolve(o);

  const up = await (o.tailnetHealth ?? ((p: number) => tailnetHealth(p)))(port);
  if (up !== true) {
    log(`${glyph("no")} tailscale — enabled but the listener is not up (${up})`);
    log("    the service binds it at startup and logs why it could not; `paddock local` restarts it");
    return;
  }

  const bin = find();
  if (bin === null) {
    log(`${glyph("unknown")} tailscale — enabled, but the \`tailscale\` CLI was not found to check its serve config`);
    log(`    listener 127.0.0.1:${port} is up · allows ${cfg.login}`);
    return;
  }

  // "Could not ask" is not "gone": a throw is reported as unknown, with why.
  let target: string | null;
  try {
    target = await servedTarget(run, bin);
  } catch (e) {
    log(`${glyph("unknown")} tailscale — could not read the serve config: ${message(e)}`);
    log("    `tailscale serve status` shows it");
    return;
  }
  if (!ownsServe(target, port)) {
    log(`${glyph("no")} tailscale — enabled but tailscale serve no longer points at it; run paddock tailscale`);
    log(target === null ? "    nothing is served on HTTPS 443" : `    HTTPS 443 serves ${target}`);
    return;
  }

  log(`${glyph("yes")} tailscale — https://${cfg.host}`);
  log(`    allows ${cfg.login} · listener 127.0.0.1:${port}`);
}

/**
 * `paddock stop`'s share: remove paddock's own 443 serve, keep the setting.
 * Never removes a serve it could not read, and never another app's.
 */
export async function stopTailscaleServe(
  o: { dir: string } & TailscaleHooks,
  log: (line: string) => void,
): Promise<void> {
  // The file, not its validity: a config `local` would act on is reason enough
  // to look, and the serve is only ever touched when it is provably ours.
  if (!existsSync(tailscaleConfigFile(o.dir))) return;
  const { port, run, find } = resolve(o);

  const bin = find();
  if (bin === null) {
    log(`${glyph("unknown")} tailscale — the \`tailscale\` CLI was not found, so its serve config could not be checked`);
    return;
  }
  let target: string | null;
  try {
    target = await servedTarget(run, bin);
  } catch (e) {
    log(`${glyph("unknown")} tailscale — could not read the serve config (${message(e)}); left as it is`);
    log("    `tailscale serve status` shows it; `tailscale serve --https=443 off` removes it");
    return;
  }
  if (target === null) return;
  if (!ownsServe(target, port)) {
    log(`    tailscale: HTTPS 443 serves ${target}, not paddock — left alone`);
    return;
  }
  try {
    await serveOff(run, bin);
  } catch (e) {
    log(`${glyph("no")} tailscale — could not remove the serve config: ${message(e)}`);
    log("    `tailscale serve --https=443 off` removes it by hand");
    return;
  }
  log(`${glyph("yes")} tailscale — serve removed; the setting is kept, so \`paddock local\` brings it back`);
}

/**
 * `paddock local`'s share: put back the serve `stop` removed, when the
 * setting is on. Refuses to overwrite another app's 443, as `paddock
 * tailscale` does. Only ever warns.
 */
export async function reapplyTailscaleServe(
  o: { dir: string } & TailscaleHooks,
  log: (line: string) => void,
): Promise<void> {
  const cfg = await readTailscaleConfig(o.dir, log);
  if (cfg === null) return;
  const { port, run, find } = resolve(o);
  const retry = "    fix that, then run `paddock tailscale` to put it back";

  const bin = find();
  if (bin === null) {
    log(`${glyph("unknown")} tailscale — enabled, but the \`tailscale\` CLI was not found; serve not re-applied`);
    log(retry);
    return;
  }
  let target: string | null;
  try {
    target = await servedTarget(run, bin);
  } catch (e) {
    log(`${glyph("unknown")} tailscale — could not read the serve config (${message(e)}); serve not re-applied`);
    log(retry);
    return;
  }
  if (target !== null && !ownsServe(target, port)) {
    log(`${glyph("unknown")} tailscale — HTTPS 443 already serves ${target}; not overwriting it`);
    log("    `tailscale serve status` shows it; free it, then run `paddock tailscale`");
    return;
  }
  if (target === null) {
    try {
      await serveOn(run, bin, port);
    } catch (e) {
      log(`${glyph("unknown")} tailscale — could not re-apply serve: ${message(e)}`);
      log(retry);
      return;
    }
  }
  log(`${glyph("yes")} tailscale — https://${cfg.host}`);
  log(`    allows ${cfg.login} · listener 127.0.0.1:${port}`);
}
