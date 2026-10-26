import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { must } from "@server/lifecycle/service/run";
import {
  ServiceError,
  type InstallResult,
  type Run,
  type ServiceManager,
  type ServiceSpec,
  type ServiceStatus,
} from "@server/lifecycle/service/types";

export const SYSTEMD_UNIT = "paddock.service";

/**
 * Quote one value for a unit file. systemd expands `%` specifiers in every
 * setting, so `%` is doubled everywhere; `$` is doubled only for ExecStart,
 * the one place it expands `$VAR`.
 */
function quote(s: string, dollar: boolean): string {
  let v = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (dollar) v = v.replace(/\$/g, "$$$$");
  return `"${v}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.keys(spec.env).sort()
    .map((k) => `Environment=${quote(`${k}=${spec.env[k]}`, false)}`);
  return [
    "# Written by `paddock local`; `paddock stop` removes it.",
    "# Edits are overwritten the next time `paddock local` runs.",
    "[Unit]",
    "Description=paddock, a dashboard for herdr",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${spec.argv.map((a) => quote(a, true)).join(" ")}`,
    ...env,
    // on-failure, not always: paddock exits 1 while herdr is unreachable (the
    // after-boot case this exists for) and 0 on SIGTERM, which must stay down.
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function systemdManager(o: { run: Run; unitDir: string; user: string }): ServiceManager {
  const unitPath = join(o.unitDir, SYSTEMD_UNIT);
  const sc = (...a: string[]) => ["systemctl", "--user", ...a];

  async function inspect(): Promise<ServiceStatus> {
    // is-active FIRST: a unit whose file was deleted by hand can still be
    // loaded and running, and calling that "absent" would let `stop` SIGTERM a
    // supervised process instead of stopping it through systemd.
    // Non-zero here (3 = inactive) is an answer, read from stdout.
    // `activating` (between restarts), `failed` and friends all mean systemd
    // still has the unit loaded; only inactive/unknown mean it does not.
    const r = await o.run(sc("is-active", SYSTEMD_UNIT));
    const state = r.out.trim();
    if (state === "active") return "active";
    if (state !== "" && state !== "inactive" && state !== "unknown") return "registered";
    return existsSync(unitPath) ? "registered" : "absent";
  }

  return {
    kind: "systemd",
    unitPath,
    logHint: "journalctl --user -u paddock",
    inspect,

    async install(spec: ServiceSpec): Promise<InstallResult> {
      const bus = await o.run(sc("show-environment"));
      if (bus.code !== 0) {
        const why = bus.err.trim().split("\n")[0] || `exit ${bus.code}`;
        throw new ServiceError(
          `systemd has no user session here (${why}) — \`paddock local\` needs \`systemctl --user\``,
        );
      }
      await mkdir(o.unitDir, { recursive: true });
      // 0600: the env snapshot can hold a PADDOCK_* token, and settings.json is
      // 0600 for the same reason. chmod too — `mode` does not touch a file
      // that already exists, and a umask can widen it.
      await writeFile(unitPath, systemdUnit(spec), { mode: 0o600 });
      await chmod(unitPath, 0o600);
      await must(o.run, sc("daemon-reload"));
      await must(o.run, sc("enable", SYSTEMD_UNIT));
      await must(o.run, sc("restart", SYSTEMD_UNIT));

      const warnings: string[] = [];
      const linger = await o.run(["loginctl", "enable-linger", o.user]);
      if (linger.code !== 0) {
        const why = linger.err.trim().split("\n")[0] || `exit ${linger.code}`;
        warnings.push(
          `could not enable linger (${why}) — it starts at login, not boot. ` +
            `To fix: sudo loginctl enable-linger ${o.user}`,
        );
      }
      return { warnings };
    },

    async uninstall(): Promise<void> {
      if ((await inspect()) === "absent") return;
      await must(o.run, sc("stop", SYSTEMD_UNIT));
      if (existsSync(unitPath)) {
        await must(o.run, sc("disable", SYSTEMD_UNIT));
        await rm(unitPath);
      }
      // A unit file deleted by hand leaves `disable` unable to run, and its
      // enable link dangling — systemd would complain about it at every boot.
      await rm(join(o.unitDir, "default.target.wants", SYSTEMD_UNIT), { force: true });
      await must(o.run, sc("daemon-reload"));
    },

    async restart(): Promise<void> {
      await must(o.run, sc("restart", SYSTEMD_UNIT));
    },

    async startsAt() {
      // Read back, never remembered: linger can be turned off by hand, and
      // claiming "boot" then would be the promise this feature exists to keep.
      const r = await o.run(["loginctl", "show-user", o.user, "--property=Linger", "--value"]);
      return r.code === 0 && r.out.trim() === "yes" ? "boot" : "login";
    },
  };
}
