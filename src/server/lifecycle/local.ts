import {
  defaultHealthCheck, httpListener, type Listener,
} from "@server/lifecycle/commands";
import type { ServiceChoice } from "@server/lifecycle/service";
import { ServiceError } from "@server/lifecycle/service/types";
import { checkState, type Probe } from "@server/lifecycle/state";
import { SettingsStore } from "@server/settings/store";
import { reapplyTailscaleServe, type TailscaleHooks } from "@server/tailscale/lifecycle";
import { glyph, say } from "@server/term";
import { tunnelHint } from "@server/tunnel/preflight";

export interface LocalOpts extends TailscaleHooks {
  dir: string;
  port: number;
  service: ServiceChoice;
  argv: string[];
  env: Record<string, string>;
  probe?: Probe;
  listener?: Listener;
  healthCheck?: (port: number) => Promise<boolean>;
  publicUrl?: () => Promise<string | null>;
  log?: (line: string) => void;
  waitMs?: number;
}

/**
 * `paddock local` — a localhost paddock the OS keeps running, through reboots.
 *
 * The reason it exists: a named tunnel in front of port 8787 is only as alive
 * as the paddock behind it, and nothing used to bring that paddock back after
 * a restart. See docs/design/2026-10-05-start-tunnel-local-service-design.md.
 *
 * Success is `/api/health` answering, not a unit file written — the rule the
 * old detached `start` followed, for the same reason: a registered service
 * that never serves is the failure this command exists to rule out.
 */
export async function runLocal(o: LocalOpts): Promise<number> {
  const log = o.log ?? say;
  if (!o.service.ok) {
    log(`paddock: ${o.service.reason}`);
    return 1;
  }
  const m = o.service.manager;

  const got = await checkState(o.dir, o.probe);
  if (got.kind === "unreadable") {
    log(`paddock: could not read state (${got.error}), refusing to guess — not registering`);
    return 1;
  }
  // The service's own instance is the one thing `local` may replace: that is
  // what makes a second run a refresh. Anything else on the port would leave
  // the service crash-looping against it.
  const ours = got.kind === "running" && got.state.managedBy !== undefined;
  if (got.kind === "running" && !ours) {
    log(`paddock: another paddock is already running (pid ${got.state.pid}, port ${got.state.port})`);
    log("  `paddock local` would start a second one on the same port. Stop it first:");
    log("    paddock stop && paddock local");
    return 1;
  }
  if (!ours && (await (o.listener ?? httpListener)(o.port)) !== null) {
    log(`paddock: a paddock no record describes is serving on port ${o.port} — not registering a second one`);
    log("  `paddock status` shows what is known about it");
    return 1;
  }

  let warnings: string[];
  try {
    ({ warnings } = await m.install({ argv: o.argv, env: o.env }));
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    log(`paddock: ${e.message}`);
    return 1;
  }
  for (const w of warnings) log(`${glyph("unknown")} ${w}`);

  const health = o.healthCheck ?? defaultHealthCheck;
  const deadline = Date.now() + (o.waitMs ?? 15_000);
  let up = false;
  while (!up && Date.now() < deadline) {
    up = await health(o.port);
    if (!up) await Bun.sleep(200);
  }

  // Put back the serve `paddock stop` removed. After the install, so it never
  // runs for a refused one; only warns, so `local`'s exit code stays its own.
  // Run whether or not health answered yet: the service keeps retrying, and
  // the serve is ready for it when it does.
  const tailscale = () => reapplyTailscaleServe(o, log);

  if (!up) {
    log(`${glyph("no")} paddock — registered as a ${m.kind} service, but not answering on port ${o.port} yet`);
    log("  it keeps retrying on its own; the usual cause is herdr not running yet");
    log(`  its output: ${m.logHint}`);
    log(`  unit: ${m.unitPath}`);
    await tailscale();
    return 1;
  }

  const when = await m.startsAt();
  log(`${glyph("yes")} paddock — running as a ${m.kind} service on 127.0.0.1:${o.port}`);
  log(`    starts at ${when} · output: ${m.logHint}`);
  log(`    unit: ${m.unitPath}`);
  log(`    captured: ${Object.keys(o.env).sort().join(" ")}`);
  await tailscale();
  const url = o.publicUrl ? await o.publicUrl() : await savedPublicUrl(o.dir);
  const hint = tunnelHint(url, true);
  if (hint !== null) log(hint);
  return 0;
}

async function savedPublicUrl(dir: string): Promise<string | null> {
  const s = new SettingsStore(dir);
  await s.load();
  return s.current().publicUrl;
}
