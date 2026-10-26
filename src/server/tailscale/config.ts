import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeRecord } from "@server/lifecycle/state";

/**
 * `<configDir>/tailscale.json`: whether the tailnet listener is on, and which
 * identity may use it. Written only by the CLI, read once at service startup.
 * It is a separate file from settings.json on purpose: the service rewrites
 * settings.json whole on every UI save, which would silently erase a CLI write,
 * and no HTTP route knows this file exists.
 */
export interface TailscaleConfig {
  enabled: boolean;
  /** The one Tailscale login allowed in, lowercased. */
  login: string;
  /** This machine's tailnet DNS name. */
  host: string;
}

const KEYS = ["enabled", "login", "host"];

export const tailscaleConfigFile = (dir: string): string => join(dir, "tailscale.json");

/** null when absent, invalid (logged, with why) or disabled. */
export async function readTailscaleConfig(
  dir: string,
  log: (m: string) => void = console.warn,
): Promise<TailscaleConfig | null> {
  const file = tailscaleConfigFile(dir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    log(`[tailscale] cannot read ${file}: ${(e as Error).message}. The tailnet listener stays off.`);
    return null;
  }
  const reject = (why: string): null => {
    log(`[tailscale] ${file} ignored: ${why}. The tailnet listener stays off; re-run \`paddock tailscale enable\`.`);
    return null;
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return reject(`not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return reject("not a JSON object");
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0) return reject(`unknown key ${unknown.join(", ")}`);
  if (typeof o.enabled !== "boolean") return reject("`enabled` must be a boolean");
  if (typeof o.login !== "string" || o.login === "") return reject("`login` must be a non-empty string");
  if (typeof o.host !== "string" || o.host === "") return reject("`host` must be a non-empty string");
  if (!o.enabled) return null;
  return { enabled: true, login: o.login, host: o.host };
}

export async function writeTailscaleConfig(dir: string, c: TailscaleConfig): Promise<void> {
  await writeRecord(dir, tailscaleConfigFile(dir), {
    enabled: c.enabled, login: c.login.toLowerCase(), host: c.host,
  });
}

export async function removeTailscaleConfig(dir: string): Promise<void> {
  await rm(tailscaleConfigFile(dir), { force: true });
}

/** The tailnet listener's port: `PADDOCK_TAILNET_PORT`, default 8789. The one place the default lives. */
export function tailnetPortFrom(env: Record<string, string | undefined>): number {
  return Number(env.PADDOCK_TAILNET_PORT ?? 8789);
}
