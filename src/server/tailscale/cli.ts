/**
 * The one place that knows the `tailscale` binary exists.
 *
 * Nothing here ever spawns the public-internet sharing subcommand: the tailnet
 * is the whole audience. `tests/tailscale-cli.test.ts` greps this directory.
 */

import { existsSync } from "node:fs";
import { ServiceError, type Run } from "@server/lifecycle/service/types";

const MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export function findTailscale(
  o: {
    which?: (b: string) => string | null;
    platform?: NodeJS.Platform;
    exists?: (p: string) => boolean;
  } = {},
): string | null {
  const which = o.which ?? ((b: string) => Bun.which(b));
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;
  const found = which("tailscale");
  if (found) return found;
  if (platform === "darwin" && exists(MAC_APP)) return MAC_APP;
  return null;
}

export interface NodeInfo {
  running: boolean;
  host: string;
  login: string;
  certs: boolean;
}

interface StatusJson {
  BackendState?: string;
  Self?: { DNSName?: string; UserID?: number };
  User?: Record<string, { LoginName?: string }>;
  CertDomains?: string[] | null;
}

export async function readNode(
  run: Run,
  bin: string,
): Promise<{ ok: true; node: NodeInfo } | { ok: false; error: string }> {
  const r = await run([bin, "status", "--json"]);
  if (r.code !== 0) {
    return { ok: false, error: r.err.trim().split("\n")[0] || `exit ${r.code}` };
  }
  let j: StatusJson;
  try {
    j = JSON.parse(r.out) as StatusJson;
  } catch (e) {
    return { ok: false, error: `tailscale status --json was not JSON: ${(e as Error).message}` };
  }
  const host = (j.Self?.DNSName ?? "").replace(/\.$/, "");
  const uid = j.Self?.UserID;
  const login = (uid === undefined ? "" : (j.User?.[String(uid)]?.LoginName ?? "")).toLowerCase();
  return {
    ok: true,
    node: {
      running: j.BackendState === "Running",
      host,
      login,
      certs: (j.CertDomains ?? []).length > 0,
    },
  };
}

/** Said after a Linux `Access denied`: the fix is one command, run once. */
export const OPERATOR_HINT =
  "on Linux, tailscale serve needs root or tailscaled's operator: " +
  "run `sudo tailscale set --operator=$USER` once, then `paddock tailscale` again";

/**
 * Run a `tailscale serve` command; throw a `ServiceError` naming it when it
 * fails. On Linux, tailscaled refuses serve changes from a user who is not its
 * operator with `Access denied`, and that error names no fix, so this adds it.
 */
async function mustServe(run: Run, argv: string[], platform: NodeJS.Platform): Promise<string> {
  const r = await run(argv);
  if (r.code === 0) return r.out;
  const why = r.err.trim().split("\n")[0] || `exit ${r.code}`;
  const hint = platform === "linux" && /access denied/i.test(r.err) ? ` — ${OPERATOR_HINT}` : "";
  throw new ServiceError(`\`${argv.join(" ")}\` failed: ${why}${hint}`);
}

interface ServeJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/**
 * The proxy target of the HTTPS 443 `/` handler, or null when 443 is not
 * served. A failing command throws: "could not ask" must not read as "free".
 */
export async function servedTarget(
  run: Run,
  bin: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const out = (await mustServe(run, [bin, "serve", "status", "--json"], platform)).trim();
  if (out === "") return null;
  const j = JSON.parse(out) as ServeJson;
  for (const [key, site] of Object.entries(j.Web ?? {})) {
    if (!key.endsWith(":443")) continue;
    return site.Handlers?.["/"]?.Proxy ?? null;
  }
  return null;
}

export async function serveOn(
  run: Run,
  bin: string,
  port: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await mustServe(run, [bin, "serve", "--bg", "--https=443", `http://127.0.0.1:${port}`], platform);
}

export async function serveOff(
  run: Run,
  bin: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await mustServe(run, [bin, "serve", "--https=443", "off"], platform);
}

/** True only for our own listener, so another app's 443 serve is never touched. */
export function ownsServe(target: string | null, port: number): boolean {
  return target === `http://127.0.0.1:${port}` || target === `http://localhost:${port}`;
}
