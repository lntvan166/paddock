import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemdManager, systemdUnit } from "@server/lifecycle/service/systemd";
import { ServiceError } from "@server/lifecycle/service/types";
import { fakeRun } from "./service-fake-run";

const SC = "systemctl --user";
const spec = {
  argv: ["/path/to/paddock"],
  env: { HOME: "/path/to/userhome", PADDOCK_SERVICE: "systemd" },
};
const unitDir = () => mkdtemp(join(tmpdir(), "paddock-systemd-"));

test("the unit runs a foreground paddock, restarts on failure, and is wanted at login/boot", () => {
  const u = systemdUnit(spec);
  expect(u).toContain("Type=simple");
  expect(u).toContain('ExecStart="/path/to/paddock"');
  expect(u).toContain('Environment="HOME=/path/to/userhome"');
  expect(u).toContain('Environment="PADDOCK_SERVICE=systemd"');
  expect(u).toContain("Restart=on-failure");
  expect(u).toContain("RestartSec=10");
  expect(u).toContain("WantedBy=default.target");
});

test("%, $, quotes and backslashes arrive verbatim", () => {
  // systemd expands %-specifiers everywhere and $VAR in ExecStart. An
  // unescaped value would be silently rewritten in the running service.
  const u = systemdUnit({
    argv: ["/path/with space/paddock", "a$b"],
    env: { PADDOCK_X: '50% "q" \\ $HOME' },
  });
  expect(u).toContain('ExecStart="/path/with space/paddock" "a$$b"');
  expect(u).toContain('Environment="PADDOCK_X=50%% \\"q\\" \\\\ $HOME"');
});

test("install writes the unit, reloads, enables, RESTARTS, and enables linger", async () => {
  const d = await unitDir();
  const { run, calls } = fakeRun();
  const m = systemdManager({ run, unitDir: d, user: "operator" });
  const r = await m.install(spec);
  expect(await readFile(join(d, "paddock.service"), "utf8")).toBe(systemdUnit(spec));
  expect(calls).toEqual([
    `${SC} show-environment`,
    `${SC} daemon-reload`,
    `${SC} enable paddock.service`,
    // restart, not `enable --now`: a second `paddock local` must move a running
    // service onto the new unit, and `--now` leaves a running one untouched.
    `${SC} restart paddock.service`,
    "loginctl enable-linger operator",
  ]);
  expect(r.warnings).toEqual([]);
});

test("no user bus is a refusal, and nothing is written", async () => {
  const d = await unitDir();
  const { run } = fakeRun({
    [`${SC} show-environment`]: { code: 1, err: "Failed to connect to bus: No medium found" },
  });
  const e = await systemdManager({ run, unitDir: d, user: "operator" }).install(spec).catch((x) => x);
  expect(e).toBeInstanceOf(ServiceError);
  expect(e.message).toContain("No medium found");
  expect(existsSync(join(d, "paddock.service"))).toBe(false);
});

test("linger refused is a warning naming the fix, not a failure", async () => {
  const d = await unitDir();
  const { run } = fakeRun({
    "loginctl enable-linger operator": { code: 1, err: "Access denied" },
  });
  const r = await systemdManager({ run, unitDir: d, user: "operator" }).install(spec);
  expect(r.warnings.join("\n")).toContain("Access denied");
  expect(r.warnings.join("\n")).toContain("sudo loginctl enable-linger operator");
});

test("a failed enable surfaces as a ServiceError", async () => {
  const d = await unitDir();
  const { run } = fakeRun({ [`${SC} enable paddock.service`]: { code: 1, err: "boom" } });
  const e = await systemdManager({ run, unitDir: d, user: "operator" }).install(spec).catch((x) => x);
  expect(e).toBeInstanceOf(ServiceError);
  expect(e.message).toContain("boom");
});

test("startsAt is boot only when linger reads back yes", async () => {
  const q = "loginctl show-user operator --property=Linger --value";
  const yes = fakeRun({ [q]: { code: 0, out: "yes\n" } });
  const no = fakeRun({ [q]: { code: 0, out: "no\n" } });
  const err = fakeRun({ [q]: { code: 1, err: "no such user" } });
  const d = await unitDir();
  expect(await systemdManager({ run: yes.run, unitDir: d, user: "operator" }).startsAt()).toBe("boot");
  expect(await systemdManager({ run: no.run, unitDir: d, user: "operator" }).startsAt()).toBe("login");
  expect(await systemdManager({ run: err.run, unitDir: d, user: "operator" }).startsAt()).toBe("login");
});

test("inspect: active beats the file — a hand-deleted unit still running is found", async () => {
  const d = await unitDir();
  const active = fakeRun({ [`${SC} is-active paddock.service`]: { code: 0, out: "active\n" } });
  expect(await systemdManager({ run: active.run, unitDir: d, user: "operator" }).inspect()).toBe("active");

  // is-active exits 3 for inactive: an ANSWER, not an error.
  const inactive = fakeRun({ [`${SC} is-active paddock.service`]: { code: 3, out: "inactive\n" } });
  const m = systemdManager({ run: inactive.run, unitDir: d, user: "operator" });
  expect(await m.inspect()).toBe("absent");
  await writeFile(join(d, "paddock.service"), "x");
  expect(await m.inspect()).toBe("registered");
});

test("uninstall stops, disables, removes the file and reloads", async () => {
  const d = await unitDir();
  await writeFile(join(d, "paddock.service"), "x");
  const { run, calls } = fakeRun({ [`${SC} is-active paddock.service`]: { code: 0, out: "active\n" } });
  await systemdManager({ run, unitDir: d, user: "operator" }).uninstall();
  expect(calls).toEqual([
    `${SC} is-active paddock.service`,
    `${SC} stop paddock.service`,
    `${SC} disable paddock.service`,
    `${SC} daemon-reload`,
  ]);
  expect(existsSync(join(d, "paddock.service"))).toBe(false);
});

test("uninstall of a running unit whose file is gone still stops it", async () => {
  const d = await unitDir();
  const { run, calls } = fakeRun({ [`${SC} is-active paddock.service`]: { code: 0, out: "active\n" } });
  await systemdManager({ run, unitDir: d, user: "operator" }).uninstall();
  expect(calls).toContain(`${SC} stop paddock.service`);
  expect(calls).not.toContain(`${SC} disable paddock.service`);
});

test("uninstall when absent does nothing", async () => {
  const d = await unitDir();
  const { run, calls } = fakeRun({ [`${SC} is-active paddock.service`]: { code: 3, out: "inactive\n" } });
  await systemdManager({ run, unitDir: d, user: "operator" }).uninstall();
  expect(calls).toEqual([`${SC} is-active paddock.service`]);
});

test("install creates a missing unit dir", async () => {
  const d = join(await unitDir(), "nested", "systemd", "user");
  const { run } = fakeRun();
  await systemdManager({ run, unitDir: d, user: "operator" }).install(spec);
  expect(existsSync(join(d, "paddock.service"))).toBe(true);
});
