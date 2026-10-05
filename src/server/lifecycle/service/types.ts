/**
 * The service a `paddock local` registers, seen through one interface.
 *
 * Nothing outside `service/` knows which manager is underneath. That is what
 * keeps `stop` and `status` free of `process.platform` branches, and what lets
 * every test drive both managers through a fake `Run` instead of the real
 * systemd on the developer's machine.
 */
export type ServiceKind = "systemd" | "launchd";

/** `registered` covers "enabled but not running" — a crash loop while herdr is down. */
export type ServiceStatus = "absent" | "registered" | "active";

export interface ServiceSpec {
  /** The full command, executable first. See `serviceArgv`. */
  argv: string[];
  /** The environment snapshot. See `serviceEnv`. */
  env: Record<string, string>;
}

export interface InstallResult {
  /** Things that worked less well than asked, said rather than hidden. */
  warnings: string[];
}

export interface ServiceManager {
  kind: ServiceKind;
  /** The unit / plist file, printed so the operator can read what was written. */
  unitPath: string;
  /** Where its output goes: a command for systemd, a path for launchd. */
  logHint: string;
  /** Read back from the system, never remembered from what install attempted. */
  startsAt(): Promise<"boot" | "login">;
  /** Write, enable, (re)start. Idempotent: a second run refreshes and restarts. */
  install(spec: ServiceSpec): Promise<InstallResult>;
  /** Stop, disable, remove. A no-op when absent. */
  uninstall(): Promise<void>;
  inspect(): Promise<ServiceStatus>;
}

/** A service-manager command failed. The message names the command and its stderr. */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

export type Run = (argv: string[]) => Promise<{ code: number; out: string; err: string }>;
