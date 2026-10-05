import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchdManager, launchdPlist } from "@server/lifecycle/service/launchd";
import { fakeRun } from "./service-fake-run";

const spec = { argv: ["/path/to/paddock"], env: { HOME: "/path/to/userhome", PADDOCK_SERVICE: "launchd" } };
const LOG = "/path/to/userhome/.config/paddock/paddock.log";
const agentDir = () => mkdtemp(join(tmpdir(), "paddock-launchd-"));
const PRINT = "launchctl print gui/501/paddock";

test("the plist runs at load, restarts only on failure, and logs to paddock.log", () => {
  const p = launchdPlist(spec, LOG);
  expect(p).toContain("<key>Label</key>\n  <string>paddock</string>");
  expect(p).toContain("<string>/path/to/paddock</string>");
  expect(p).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(p).toContain("<key>SuccessfulExit</key>\n    <false/>");
  expect(p).toContain(`<key>StandardOutPath</key>\n  <string>${LOG}</string>`);
  expect(p).toContain("<key>PADDOCK_SERVICE</key>\n    <string>launchd</string>");
});

test("XML-special characters arrive verbatim", () => {
  const p = launchdPlist({ argv: ["/a&b/<p>"], env: { PADDOCK_X: "1 < 2 & 3" } }, LOG);
  expect(p).toContain("<string>/a&amp;b/&lt;p&gt;</string>");
  expect(p).toContain("<string>1 &lt; 2 &amp; 3</string>");
});

test("install on a fresh machine writes the plist and bootstraps it", async () => {
  const d = await agentDir();
  const { run, calls } = fakeRun({ [PRINT]: { code: 113, err: "Could not find service" } });
  const r = await launchdManager({ run, agentDir: d, uid: 501, logFile: LOG }).install(spec);
  expect(await readFile(join(d, "paddock.plist"), "utf8")).toBe(launchdPlist(spec, LOG));
  expect(calls).toEqual([PRINT, `launchctl bootstrap gui/501 ${join(d, "paddock.plist")}`]);
  expect(r.warnings).toEqual([]);
});

test("install over a loaded agent boots it out first, so the new plist takes effect", async () => {
  const d = await agentDir();
  const { run, calls } = fakeRun({ [PRINT]: { code: 0, out: "state = running" } });
  await launchdManager({ run, agentDir: d, uid: 501, logFile: LOG }).install(spec);
  expect(calls).toEqual([PRINT, "launchctl bootout gui/501/paddock", `launchctl bootstrap gui/501 ${join(d, "paddock.plist")}`]);
});

test("a failed bootstrap is a ServiceError", async () => {
  const d = await agentDir();
  const { run } = fakeRun({
    [PRINT]: { code: 113 },
    [`launchctl bootstrap gui/501 ${join(d, "paddock.plist")}`]: { code: 5, err: "Input/output error" },
  });
  const e = await launchdManager({ run, agentDir: d, uid: 501, logFile: LOG }).install(spec).catch((x) => x);
  expect(e.name).toBe("ServiceError");
  expect(e.message).toContain("Input/output error");
});

test("startsAt is always login — a LaunchAgent cannot start before one", async () => {
  const d = await agentDir();
  expect(await launchdManager({ run: fakeRun().run, agentDir: d, uid: 501, logFile: LOG }).startsAt()).toBe("login");
});

test("inspect reads launchctl print, then the file", async () => {
  const d = await agentDir();
  const m = (out: string, code: number) =>
    launchdManager({ run: fakeRun({ [PRINT]: { code, out } }).run, agentDir: d, uid: 501, logFile: LOG });
  expect(await m("state = running", 0).inspect()).toBe("active");
  expect(await m("state = waiting", 0).inspect()).toBe("registered");
  expect(await m("", 113).inspect()).toBe("absent");
  await writeFile(join(d, "paddock.plist"), "x");
  expect(await m("", 113).inspect()).toBe("registered");
});

test("uninstall boots out a loaded agent and removes the plist", async () => {
  const d = await agentDir();
  await writeFile(join(d, "paddock.plist"), "x");
  const { run, calls } = fakeRun({ [PRINT]: { code: 0, out: "state = running" } });
  await launchdManager({ run, agentDir: d, uid: 501, logFile: LOG }).uninstall();
  expect(calls).toEqual([PRINT, "launchctl bootout gui/501/paddock"]);
  expect(existsSync(join(d, "paddock.plist"))).toBe(false);
});

test("uninstall of an unloaded plist just removes the file", async () => {
  const d = await agentDir();
  await writeFile(join(d, "paddock.plist"), "x");
  const { run, calls } = fakeRun({ [PRINT]: { code: 113 } });
  await launchdManager({ run, agentDir: d, uid: 501, logFile: LOG }).uninstall();
  expect(calls).toEqual([PRINT]);
  expect(existsSync(join(d, "paddock.plist"))).toBe(false);
});
