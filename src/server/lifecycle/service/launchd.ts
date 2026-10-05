import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { must } from "@server/lifecycle/service/run";
import type {
  InstallResult, Run, ServiceManager, ServiceSpec, ServiceStatus,
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
  o: { run: Run; agentDir: string; uid: number; logFile: string },
): ServiceManager {
  const unitPath = join(o.agentDir, `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${o.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;

  // `print` exits non-zero (113) for "not loaded": an answer, not an error.
  const loaded = async () => {
    const r = await o.run(["launchctl", "print", target]);
    return { loaded: r.code === 0, running: r.code === 0 && /\bstate = running\b/.test(r.out) };
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
      await writeFile(unitPath, launchdPlist(spec, o.logFile));
      // A loaded agent keeps its OLD definition until booted out; without this
      // a second `paddock local` would report success and change nothing.
      if ((await loaded()).loaded) await must(o.run, ["launchctl", "bootout", target]);
      await must(o.run, ["launchctl", "bootstrap", domain, unitPath]);
      return { warnings: [] };
    },

    async uninstall(): Promise<void> {
      if ((await loaded()).loaded) await must(o.run, ["launchctl", "bootout", target]);
      if (existsSync(unitPath)) await rm(unitPath);
    },

    async startsAt() {
      return "login";
    },
  };
}
