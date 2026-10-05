import { expect, test } from "bun:test";
import { serviceEnv, serviceKindOf } from "@server/lifecycle/service/env";
import { serviceArgv, stableExecPath } from "@server/lifecycle/service/argv";
import { must } from "@server/lifecycle/service/run";
import { ServiceError, type Run } from "@server/lifecycle/service/types";

test("the snapshot keeps PATH, HOME, HERDR_* and PADDOCK_* and nothing else", () => {
  const got = serviceEnv({
    PATH: "/usr/bin:/path/to/bun/bin",
    HOME: "/path/to/userhome",
    HERDR_SOCKET_PATH: "/path/to/herdr.sock",
    PADDOCK_PORT: "8790",
    SHELL: "/bin/zsh",
    SSH_AUTH_SOCK: "/tmp/agent",
    UNSET: undefined,
  }, "systemd");
  expect(got).toEqual({
    PATH: "/usr/bin:/path/to/bun/bin",
    HOME: "/path/to/userhome",
    HERDR_SOCKET_PATH: "/path/to/herdr.sock",
    PADDOCK_PORT: "8790",
    PADDOCK_SERVICE: "systemd",
  });
});

test("an inherited PADDOCK_SERVICE is replaced, never copied through", () => {
  // `paddock local` run from inside the service's own environment must not
  // write the old kind into the new unit.
  expect(serviceEnv({ PADDOCK_SERVICE: "launchd" }, "systemd").PADDOCK_SERVICE).toBe("systemd");
});

test("serviceKindOf accepts only the two kinds", () => {
  expect(serviceKindOf({ PADDOCK_SERVICE: "systemd" })).toBe("systemd");
  expect(serviceKindOf({ PADDOCK_SERVICE: "launchd" })).toBe("launchd");
  expect(serviceKindOf({ PADDOCK_SERVICE: "yes" })).toBeUndefined();
  expect(serviceKindOf({})).toBeUndefined();
});

test("a Homebrew Cellar path becomes the stable opt path, which survives brew upgrade", () => {
  const cellar = "/path/to/brew/Cellar/paddock/0.9.0/bin/paddock";
  const opt = "/path/to/brew/opt/paddock/bin/paddock";
  expect(stableExecPath(cellar, (p) => p === opt)).toBe(opt);
});

test("a Cellar path is kept when the opt link does not exist — never a guessed path", () => {
  const cellar = "/path/to/brew/Cellar/paddock/0.9.0/bin/paddock";
  expect(stableExecPath(cellar, () => false)).toBe(cellar);
});

test("any other path is left alone", () => {
  expect(stableExecPath("/path/to/userhome/.local/bin/paddock", () => true))
    .toBe("/path/to/userhome/.local/bin/paddock");
});

test("serviceArgv rewrites only the executable", () => {
  const cellar = "/x/Cellar/paddock/1.0.0/bin/paddock";
  expect(serviceArgv([cellar], () => true)).toEqual(["/x/opt/paddock/bin/paddock"]);
  expect(serviceArgv(["/path/to/bun", "/path/to/src/server/index.ts"], () => true))
    .toEqual(["/path/to/bun", "/path/to/src/server/index.ts"]);
});

test("must() throws a ServiceError naming the command and its stderr", async () => {
  const run: Run = async () => ({ code: 1, out: "", err: "Failed to connect to bus\nmore" });
  const e = await must(run, ["systemctl", "--user", "daemon-reload"]).catch((x) => x);
  expect(e).toBeInstanceOf(ServiceError);
  expect(e.message).toContain("systemctl --user daemon-reload");
  expect(e.message).toContain("Failed to connect to bus");
});

test("must() returns stdout on success", async () => {
  const run: Run = async () => ({ code: 0, out: "ok\n", err: "" });
  expect(await must(run, ["true"])).toBe("ok\n");
});
