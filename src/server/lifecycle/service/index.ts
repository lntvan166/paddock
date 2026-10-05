import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { logFile } from "@server/lifecycle/commands";
import { launchdManager } from "@server/lifecycle/service/launchd";
import { spawnRun } from "@server/lifecycle/service/run";
import { systemdManager } from "@server/lifecycle/service/systemd";
import type { Run, ServiceManager } from "@server/lifecycle/service/types";

export type ServiceChoice =
  | { ok: true; manager: ServiceManager }
  | { ok: false; reason: string };

/**
 * The service manager for this machine. Every argument is injectable so tests
 * never read the developer's real home, user or uid.
 */
export function serviceManager(o: {
  configDir: string;
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  user?: string;
  uid?: number;
  run?: Run;
}): ServiceChoice {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const run = o.run ?? spawnRun;
  // The off switch, for a container with no user session and for every test
  // that spawns paddock: with it set, nothing here can reach a real systemd or
  // launchd. Env tricks on the bus address do not — systemctl --user finds
  // $XDG_RUNTIME_DIR/systemd/private on its own.
  if (env.PADDOCK_NO_SERVICE === "1") {
    return { ok: false, reason: "service management is off here (PADDOCK_NO_SERVICE=1)" };
  }
  if (platform === "linux") {
    const config = env.XDG_CONFIG_HOME || join(home, ".config");
    return {
      ok: true,
      manager: systemdManager({
        run, unitDir: join(config, "systemd", "user"), user: o.user ?? userInfo().username,
      }),
    };
  }
  if (platform === "darwin") {
    return {
      ok: true,
      manager: launchdManager({
        run,
        agentDir: join(home, "Library", "LaunchAgents"),
        uid: o.uid ?? process.getuid!(),
        logFile: logFile(o.configDir),
      }),
    };
  }
  return {
    ok: false,
    reason: `\`paddock local\` needs systemd (Linux) or launchd (macOS); this is ${platform}`,
  };
}
