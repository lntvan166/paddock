import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { must } from "@server/lifecycle/service/run";
import {
  ServiceError,
  type InstallResult, type Run, type ServiceManager, type ServiceSpec, type ServiceStatus,
} from "@server/lifecycle/service/types";

export const LAUNCHD_LABEL = "paddock";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(spec: ServiceSpec, logFile: string): string {
  const args = spec.argv.map((a) => `    <string>${xml(a)}</string>`);
  const env = Object.keys(spec.env).sort()
    .flatMap((k) => [`    <key>${xml(k)}</key>`, `    <string>${xml(spec.env[k]!)}</string>`]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<!-- Written by `paddock local`; `paddock stop` removes it. -->",
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...env,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    // Restart only on failure — the systemd unit's Restart=on-failure, same reason.
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(logFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function launchdManager(
  o: {
    run: Run; agentDir: string; uid: number; logFile: string;
    /** How often, and for how long, to wait for a bootout to finish. Injected for tests. */
    pollMs?: number; settleMs?: number;
  },
): ServiceManager {
  const unitPath = join(o.agentDir, `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${o.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;

  // `print` exits non-zero (113) for "not loaded": an answer, not an error.
  const loaded = async () => {
    const r = await o.run(["launchctl", "print", target]);
    return { loaded: r.code === 0, running: r.code === 0 && /\bstate = running\b/.test(r.out) };
  };

  /**
   * bootout, then wait until launchd no longer has the job. `bootout` can
   * return while the job is still tearing down, and a bootstrap straight after
   * fails ("Bootstrap failed: 5") — which on a re-install leaves NOTHING
   * loaded until the next login. Bounded: a job that never goes is an error.
   */
  const bootout = async () => {
    await must(o.run, ["launchctl", "bootout", target]);
    const settleMs = o.settleMs ?? 5_000;
    const deadline = Date.now() + settleMs;
    while ((await loaded()).loaded) {
      if (Date.now() >= deadline) {
        throw new ServiceError(
          `${target} is still loaded ${settleMs / 1000}s after bootout — try again shortly`,
        );
      }
      await Bun.sleep(o.pollMs ?? 100);
    }
  };

  return {
    kind: "launchd",
    unitPath,
    logHint: o.logFile,

    async inspect(): Promise<ServiceStatus> {
      const l = await loaded();
      if (l.running) return "active";
      if (l.loaded || existsSync(unitPath)) return "registered";
      return "absent";
    },

    async install(spec: ServiceSpec): Promise<InstallResult> {
      await mkdir(o.agentDir, { recursive: true });
      // 0600 for the reason the systemd unit is: the env can hold a token.
      await writeFile(unitPath, launchdPlist(spec, o.logFile), { mode: 0o600 });
      await chmod(unitPath, 0o600);
      // A loaded agent keeps its OLD definition until booted out; without this
      // a second `paddock local` would report success and change nothing.
      if ((await loaded()).loaded) await bootout();
      await must(o.run, ["launchctl", "bootstrap", domain, unitPath]);
      return { warnings: [] };
    },

    async uninstall(): Promise<void> {
      // Waited out here too, so `stop` does not find the record still live and
      // signal a process launchd is already taking down.
      if ((await loaded()).loaded) await bootout();
      if (existsSync(unitPath)) await rm(unitPath);
    },

    async restart(): Promise<void> {
      // -k kills the running instance first; without it kickstart is a no-op
      // on a job that is already running.
      await must(o.run, ["launchctl", "kickstart", "-k", target]);
    },

    async startsAt() {
      return "login";
    },
  };
}
