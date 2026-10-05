import { expect, test } from "bun:test";
import { serviceManager } from "@server/lifecycle/service";
import { fakeRun } from "./service-fake-run";

const base = { configDir: "/path/to/userhome/.config/paddock", home: "/path/to/userhome", user: "operator", uid: 501, run: fakeRun().run };

test("linux picks systemd, honouring XDG_CONFIG_HOME", () => {
  const a = serviceManager({ ...base, platform: "linux", env: {} });
  expect(a.ok && a.manager.kind).toBe("systemd");
  expect(a.ok && a.manager.unitPath).toBe("/path/to/userhome/.config/systemd/user/paddock.service");
  const b = serviceManager({ ...base, platform: "linux", env: { XDG_CONFIG_HOME: "/path/to/xdg" } });
  expect(b.ok && b.manager.unitPath).toBe("/path/to/xdg/systemd/user/paddock.service");
});

test("darwin picks launchd, logging to its own file in the config dir", () => {
  const c = serviceManager({ ...base, platform: "darwin", env: {} });
  expect(c.ok && c.manager.kind).toBe("launchd");
  expect(c.ok && c.manager.unitPath).toBe("/path/to/userhome/Library/LaunchAgents/paddock.plist");
  // Its OWN file: `paddock start` truncates paddock.log on every run, which
  // would wipe the service's history (and write into a file launchd holds open).
  expect(c.ok && c.manager.logHint).toBe("/path/to/userhome/.config/paddock/paddock-service.log");
});

test("anything else is a refusal naming the platform, never a fallback", () => {
  const w = serviceManager({ ...base, platform: "win32", env: {} });
  expect(w.ok).toBe(false);
  expect(!w.ok && w.reason).toContain("win32");
});

test("PADDOCK_NO_SERVICE=1 turns service management off on every platform", () => {
  // The seam every spawned-process test uses. Pointing the bus env at nowhere
  // does NOT isolate systemctl --user — it connects to
  // $XDG_RUNTIME_DIR/systemd/private first — so `make test` once stopped a
  // real service. A refusal here means no test process can reach one.
  for (const platform of ["linux", "darwin"]) {
    const c = serviceManager({ ...base, platform, env: { PADDOCK_NO_SERVICE: "1" } });
    expect(c.ok).toBe(false);
    expect(!c.ok && c.reason).toContain("PADDOCK_NO_SERVICE");
  }
});
