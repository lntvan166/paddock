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

test("darwin picks launchd, logging to the config dir's paddock.log", () => {
  const c = serviceManager({ ...base, platform: "darwin", env: {} });
  expect(c.ok && c.manager.kind).toBe("launchd");
  expect(c.ok && c.manager.unitPath).toBe("/path/to/userhome/Library/LaunchAgents/paddock.plist");
  expect(c.ok && c.manager.logHint).toBe("/path/to/userhome/.config/paddock/paddock.log");
});

test("anything else is a refusal naming the platform, never a fallback", () => {
  const w = serviceManager({ ...base, platform: "win32", env: {} });
  expect(w.ok).toBe(false);
  expect(!w.ok && w.reason).toContain("win32");
});
