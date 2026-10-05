# `start` publishes, `local` survives a reboot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `paddock start` becomes a detached quick tunnel; a new `paddock local` registers paddock as a systemd/launchd user service that comes back after a reboot; `stop`/`status` understand that service.

**Architecture:** A new `src/server/lifecycle/service/` module hides systemd and launchd behind one `ServiceManager` interface, with every shell-out going through an injected `Run`. `paddock local` (`lifecycle/local.ts`) installs it and waits for `/api/health`. `stop` uninstalls the service before it would signal anything; `status` reports it. `start` reuses the existing `tunnel --detach` path and picks `--publish-running` itself when a paddock is already serving.

**Tech Stack:** Bun + TypeScript, `bun:test`, systemd user units, launchd LaunchAgents.

**Spec:** `docs/design/2026-10-05-start-tunnel-local-service-design.md` — read it before Task 1.

## Global Constraints

- THIS REPOSITORY IS PUBLIC. No usernames, hostnames, absolute home paths or emails in code, tests, comments, commits. Tests use `/path/to/userhome`, `operator`, uid `501`. Runtime values (the real user name) may be PRINTED, never committed.
- Never write `/home/<anything>` or `/Users/<anything>` in a test path, not even under `/path/to/`: the scanner matches the substring. `/path/to/userhome` is the stand-in.
- Never swallow errors: no empty catch, no ignored non-zero exit codes. A non-zero exit that is an ANSWER (e.g. `systemctl is-active` → inactive) is read as an answer and commented as such.
- `paddock local` never falls back silently: unsupported platform / no user bus → refusal naming the reason, exit 1.
- Never claim "starts at boot" unless linger was read back as `yes`. launchd always reports `login`.
- Bare `paddock` (foreground serve) behaviour is unchanged.
- `paddock tunnel` and all its flags, including `--detach`, are unchanged.
- Unit name `paddock.service`; launchd label `paddock`; plist `~/Library/LaunchAgents/paddock.plist`; unit dir `$XDG_CONFIG_HOME/systemd/user` (default `~/.config/systemd/user`).
- **Refinement of the spec, deliberate:** `Restart=on-failure` (systemd) and `KeepAlive = { SuccessfulExit = false }` (launchd), not `Restart=always`. paddock exits 0 on SIGTERM and 1 when herdr is unreachable, so on-failure still covers the herdr-down retry loop, while a stray SIGTERM does not get resurrected. Task 8 updates the spec text to match.
- **Refinement of the spec, deliberate:** `paddock start` REFUSES when the `local` service is registered but not serving (herdr down after boot). Running its own paddock there would fight the service for the port the moment herdr appears.
- Run `make check` (tsc) and `make check-clean` before every commit; `make test` (not bare `bun test`) at the end of each task. Single-file runs with `bun test tests/<file>` are fine while iterating.
- Commit messages end with the session's Co-Authored-By attribution trailer. It is NOT written into this file or any tracked file: it contains an email address, which `make check-clean` rejects. Add it at commit time.

## Review Focus

1. **Homebrew upgrade breaks the unit.** `process.execPath` of a brew install is `…/Cellar/paddock/<ver>/bin/paddock`, which `brew upgrade` deletes → the service dies at next boot. Expect the unit to name the stable `…/opt/paddock/bin/paddock`. Pinned in Task 1 (`stableExecPath`).
2. **Environment values with `%`, `$`, quotes or spaces** (e.g. a `PATH` entry with a space, a `PADDOCK_*` value containing `%`). systemd expands `%` specifiers everywhere and `$VAR` in `ExecStart`; plist needs XML escaping. Expect the value to arrive verbatim. Pinned in Tasks 2 and 3.
3. **`paddock stop` where the unit file was deleted by hand but systemd still has it loaded and running.** A SIGTERM would leave it to start again at boot / the process supervised. Expect `stop` to still stop it via systemctl. Pinned in Task 2 (`inspect` checks `is-active` before the file) and Task 6.
4. **`paddock local` run a second time, after the binary moved or env changed.** Expect the unit rewritten and the service RESTARTED onto the new command, not left on the old one. Pinned in Task 2 (`enable` then `restart`, never `enable --now`).
5. **`paddock local` while a foreground `paddock` (or an untracked one) holds the port.** Expect a refusal, not a crash-looping service fighting it. Pinned in Task 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/lifecycle/service/types.ts` (new) | `ServiceManager`, `ServiceSpec`, `ServiceStatus`, `ServiceKind`, `Run`, `ServiceError`. No logic. |
| `src/server/lifecycle/service/run.ts` (new) | `spawnRun` (real `Run`) and `must()` (throw `ServiceError` on non-zero). |
| `src/server/lifecycle/service/env.ts` (new) | `serviceEnv` snapshot, `serviceKindOf`. |
| `src/server/lifecycle/service/argv.ts` (new) | `stableExecPath`, `serviceArgv`. |
| `src/server/lifecycle/service/systemd.ts` (new) | `systemdUnit` text + `systemdManager`. |
| `src/server/lifecycle/service/launchd.ts` (new) | `launchdPlist` text + `launchdManager`. |
| `src/server/lifecycle/service/index.ts` (new) | `serviceManager()` platform selection → `ServiceChoice`. |
| `src/server/lifecycle/local.ts` (new) | `runLocal` — the `paddock local` command. |
| `src/server/lifecycle/start.ts` (new) | `startRoute` — what `paddock start` does given state + service. |
| `src/server/lifecycle/state.ts` | `PaddockState.managedBy?`. |
| `src/server/lifecycle/commands.ts` | `runStatus`/`runStop` take `service?`; export `defaultHealthCheck`; delete `runStart`/`StartOpts`. |
| `src/server/cli.ts` | `local` verb, new `USAGE`. |
| `src/server/index.ts` | dispatch `local`, `start` → detached tunnel, pass `service` to status/stop, record `managedBy`. |
| `src/server/tunnel/preflight.ts` | detached `tunnelHint` text → `paddock start`. |
| `src/server/update.ts` | restart hint no longer says `paddock start` for a localhost instance. |
| `tests/service-fake-run.ts` (new) | shared fake `Run` for service tests. |
| docs: `README.md`, `docs/running-locally.md`, `docs/decisions.md`, `docs/roadmap.md`, `docs/architecture.md`, the spec | Task 8. |

---

### Task 1: Service types, runner, env snapshot, stable argv

**Files:**
- Create: `src/server/lifecycle/service/types.ts`, `run.ts`, `env.ts`, `argv.ts`
- Test: `tests/service-env.test.ts`

**Interfaces:**
- Produces:
  - `type ServiceKind = "systemd" | "launchd"`
  - `type ServiceStatus = "absent" | "registered" | "active"`
  - `interface ServiceSpec { argv: string[]; env: Record<string, string> }`
  - `interface InstallResult { warnings: string[] }`
  - `interface ServiceManager { kind; unitPath: string; logHint: string; startsAt(): Promise<"boot" | "login">; install(spec): Promise<InstallResult>; uninstall(): Promise<void>; inspect(): Promise<ServiceStatus> }`
  - `class ServiceError extends Error`
  - `type Run = (argv: string[]) => Promise<{ code: number; out: string; err: string }>`
  - `spawnRun: Run`, `must(run: Run, argv: string[]): Promise<string>`
  - `serviceEnv(env: Record<string, string | undefined>, kind: ServiceKind): Record<string, string>`
  - `serviceKindOf(env: Record<string, string | undefined>): ServiceKind | undefined`
  - `stableExecPath(execPath: string, exists?: (p: string) => boolean): string`
  - `serviceArgv(base?: string[], exists?: (p: string) => boolean): string[]`

- [ ] **Step 1: Write the failing tests**

`tests/service-env.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/service-env.test.ts`
Expected: FAIL — `Cannot find module '@server/lifecycle/service/env'`.

- [ ] **Step 3: Implement**

`src/server/lifecycle/service/types.ts`:

```ts
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
```

`src/server/lifecycle/service/run.ts`:

```ts
import { ServiceError, type Run } from "@server/lifecycle/service/types";

/**
 * The real `Run`. A missing executable (no `systemctl` on this box) comes back
 * as exit 127 with the spawn error as stderr — an answer the caller reports,
 * not an exception that escapes as a stack trace.
 */
export const spawnRun: Run = async (argv) => {
  let p;
  try {
    p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { code: 127, out: "", err: (e as Error).message };
  }
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
};

/** Run, and throw a `ServiceError` naming the command when it exits non-zero. */
export async function must(run: Run, argv: string[]): Promise<string> {
  const r = await run(argv);
  if (r.code !== 0) {
    const why = r.err.trim().split("\n")[0] || `exit ${r.code}`;
    throw new ServiceError(`\`${argv.join(" ")}\` failed: ${why}`);
  }
  return r.out;
}
```

`src/server/lifecycle/service/env.ts`:

```ts
import type { ServiceKind } from "@server/lifecycle/service/types";

/**
 * The environment the service will run with, captured at `paddock local`.
 *
 * A service manager starts paddock with almost nothing set: no PATH to find
 * bun in a dev run, and none of the `HERDR_*` / `PADDOCK_*` overrides the
 * operator's shell has — so a paddock pointed at a non-default herdr socket
 * would come up at boot looking at the wrong one. Only these four groups are
 * copied: everything else in a shell (agent sockets, tokens) has no business
 * in a unit file.
 *
 * `PADDOCK_SERVICE` is always SET, never copied. It is how the running
 * paddock knows it is supervised (see `serviceKindOf`).
 */
export function serviceEnv(
  env: Record<string, string | undefined>,
  kind: ServiceKind,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === "PADDOCK_SERVICE") continue;
    if (k === "PATH" || k === "HOME" || k.startsWith("HERDR_") || k.startsWith("PADDOCK_")) {
      out[k] = v;
    }
  }
  out.PADDOCK_SERVICE = kind;
  return out;
}

/** The kind this process was started under, or undefined for any other value. */
export function serviceKindOf(env: Record<string, string | undefined>): ServiceKind | undefined {
  const v = env.PADDOCK_SERVICE;
  return v === "systemd" || v === "launchd" ? v : undefined;
}
```

`src/server/lifecycle/service/argv.ts`:

```ts
import { existsSync } from "node:fs";
import { childCommand } from "@server/lifecycle/commands";

/**
 * The executable path a unit file should name.
 *
 * `process.execPath` resolves symlinks, so a Homebrew install reports its
 * VERSIONED Cellar path — which `brew upgrade` deletes. A unit naming it would
 * work today and fail at the next boot after an upgrade, the one moment
 * nobody is watching. Homebrew keeps `<prefix>/opt/<name>` pointing at the
 * current version, so that is named instead — but only if it exists: a
 * guessed path is worse than the one we know works today.
 */
export function stableExecPath(
  execPath: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/([^/]+)$/.exec(execPath);
  if (m === null) return execPath;
  const opt = `${m[1]}/opt/${m[2]}/bin/${m[3]}`;
  return exists(opt) ? opt : execPath;
}

/** This exact build, no verb — a foreground paddock, which is what a unit must run. */
export function serviceArgv(
  base: string[] = childCommand(),
  exists: (p: string) => boolean = existsSync,
): string[] {
  const [exe, ...rest] = base;
  return [stableExecPath(exe!, exists), ...rest];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/service-env.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/lifecycle/service tests/service-env.test.ts
git commit -m "feat: the pieces a paddock service is built from"
```

---

### Task 2: systemd manager

**Files:**
- Create: `src/server/lifecycle/service/systemd.ts`, `tests/service-fake-run.ts`
- Test: `tests/service-systemd.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `must`.
- Produces: `SYSTEMD_UNIT = "paddock.service"`, `systemdUnit(spec: ServiceSpec): string`, `systemdManager(o: { run: Run; unitDir: string; user: string }): ServiceManager`, and `fakeRun(answers?)` in `tests/service-fake-run.ts`.

- [ ] **Step 1: Write the shared fake and the failing tests**

`tests/service-fake-run.ts`:

```ts
import type { Run } from "@server/lifecycle/service/types";

export type Answer = { code: number; out?: string; err?: string };

/**
 * A `Run` that records every command and answers from a table keyed by the
 * joined argv. Unlisted commands succeed with no output — tests list exactly
 * the answers that matter to them.
 */
export function fakeRun(answers: Record<string, Answer> = {}) {
  const calls: string[] = [];
  const run: Run = async (argv) => {
    const k = argv.join(" ");
    calls.push(k);
    const a = answers[k] ?? { code: 0 };
    return { code: a.code, out: a.out ?? "", err: a.err ?? "" };
  };
  return { run, calls };
}
```

`tests/service-systemd.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
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
```

(Unused `mkdir` import: remove it if tsc flags it.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/service-systemd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/lifecycle/service/systemd.ts`:

```ts
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
    const r = await o.run(sc("is-active", SYSTEMD_UNIT));
    if (r.out.trim() === "active") return "active";
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
      await writeFile(unitPath, systemdUnit(spec));
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
      await must(o.run, sc("daemon-reload"));
    },

    async startsAt() {
      // Read back, never remembered: linger can be turned off by hand, and
      // claiming "boot" then would be the promise this feature exists to keep.
      const r = await o.run(["loginctl", "show-user", o.user, "--property=Linger", "--value"]);
      return r.code === 0 && r.out.trim() === "yes" ? "boot" : "login";
    },
  };
}
```

Note the uninstall-when-file-gone test expects `daemon-reload` too; it only asserts `contains stop` / `not disable`, so this matches. The "uninstall stops, disables…" test expects exactly `is-active, stop, disable, daemon-reload` — matches.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/service-systemd.test.ts`
Expected: PASS. If the `$` escaping assertion fails, check `"$$$$"` — in `String.replace`, `$$` is a literal `$`, so `"$$$$"` produces `$$`.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/lifecycle/service/systemd.ts tests/service-fake-run.ts tests/service-systemd.test.ts
git commit -m "feat: a systemd user unit for paddock, behind the service interface"
```

---

### Task 3: launchd manager

**Files:**
- Create: `src/server/lifecycle/service/launchd.ts`
- Test: `tests/service-launchd.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `must`; `fakeRun` from Task 2.
- Produces: `LAUNCHD_LABEL = "paddock"`, `launchdPlist(spec: ServiceSpec, logFile: string): string`, `launchdManager(o: { run: Run; agentDir: string; uid: number; logFile: string }): ServiceManager`.

- [ ] **Step 1: Write the failing tests**

`tests/service-launchd.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/service-launchd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/lifecycle/service/launchd.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/service-launchd.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/lifecycle/service/launchd.ts tests/service-launchd.test.ts
git commit -m "feat: a launchd agent for paddock, behind the same interface"
```

---

### Task 4: Platform selection and `managedBy` in the state record

**Files:**
- Create: `src/server/lifecycle/service/index.ts`
- Modify: `src/server/lifecycle/state.ts` (`PaddockState`, ~line 6), `src/server/index.ts` (`recordState` call, ~line 1064)
- Test: `tests/service-select.test.ts`, extend `tests/lifecycle-state.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `logFile(dir)` from `commands.ts`.
- Produces:
  - `type ServiceChoice = { ok: true; manager: ServiceManager } | { ok: false; reason: string }`
  - `serviceManager(o: { configDir: string; platform?: string; env?: Record<string, string | undefined>; home?: string; user?: string; uid?: number; run?: Run }): ServiceChoice`
  - `PaddockState.managedBy?: ServiceKind`

- [ ] **Step 1: Write the failing tests**

`tests/service-select.test.ts`:

```ts
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
```

Append to `tests/lifecycle-state.test.ts` (check its existing imports for `writeState`/`checkState`/`mkdtemp`/`tmpdir`/`join` and add any missing):

```ts
test("managedBy survives a write and read, and an old record without it still parses", async () => {
  const d = await mkdtemp(join(tmpdir(), "paddock-managed-"));
  const base = { pid: process.pid, args: capturedArgs(process.pid)!, port: 8787, version: "0.9.0", startedAt: 1 };
  await writeState(d, { ...base, managedBy: "systemd" });
  const a = await checkState(d);
  expect(a.kind === "running" && a.state.managedBy).toBe("systemd");
  await writeState(d, base);
  const b = await checkState(d);
  expect(b.kind === "running" && b.state.managedBy).toBeUndefined();
});
```

(`capturedArgs` is exported from `@server/lifecycle/state`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/service-select.test.ts tests/lifecycle-state.test.ts`
Expected: FAIL — module not found; tsc-level complaint about `managedBy`.

- [ ] **Step 3: Implement**

`src/server/lifecycle/service/index.ts`:

```ts
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
```

`src/server/lifecycle/state.ts` — add to `PaddockState`:

```ts
  /**
   * Set when a service manager started this paddock (`paddock local`). `stop`
   * and `local` read it: a supervised paddock is stopped through its manager,
   * never signalled, and is the one instance `local` may replace.
   * Optional: records written before it existed still parse.
   */
  managedBy?: ServiceKind;
```

with `import type { ServiceKind } from "@server/lifecycle/service/types";` at the top. `isPaddockState` does not change.

`src/server/index.ts` — the `recordState(stateDir, {...})` call gains one field, and `serviceKindOf` is imported from `@server/lifecycle/service/env`:

```ts
await recordState(stateDir, {
  pid: process.pid,
  port: PORT,
  version: VERSION,
  startedAt: Date.now(),
  managedBy: serviceKindOf(process.env),
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/service-select.test.ts tests/lifecycle-state.test.ts && make check`
Expected: PASS; tsc clean. If tsc reports an import cycle problem between `commands.ts` and `service/argv.ts`/`service/index.ts`, it is only type-level-safe if neither module touches the other's exports at load time — they only call functions, so Bun resolves it; leave a one-line comment if you confirm that.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/server/lifecycle/service/index.ts src/server/lifecycle/state.ts src/server/index.ts tests/service-select.test.ts tests/lifecycle-state.test.ts
git commit -m "feat: pick the service manager per platform; a supervised paddock says so in its record"
```

---

### Task 5: `paddock local`

**Files:**
- Create: `src/server/lifecycle/local.ts`
- Modify: `src/server/cli.ts` (Command union, `commandFor`, `USAGE`), `src/server/index.ts` (dispatch, beside `status`), `src/server/lifecycle/commands.ts` (`export` `defaultHealthCheck`, ~line 743), `src/server/tunnel/preflight.ts` (`tunnelHint` detached text)
- Test: `tests/lifecycle-local.test.ts`, extend `tests/cli.test.ts`, `tests/tunnel-hints.test.ts`

**Interfaces:**
- Consumes: `ServiceChoice` (Task 4), `ServiceError`, `checkState`, `httpListener`/`Listener`, `defaultHealthCheck`, `tunnelHint`, `SettingsStore`, `serviceArgv`, `serviceEnv`.
- Produces: `runLocal(o: LocalOpts): Promise<number>` where

```ts
export interface LocalOpts {
  dir: string;
  port: number;
  service: ServiceChoice;
  argv: string[];
  env: Record<string, string>;
  probe?: Probe;
  listener?: Listener;
  healthCheck?: (port: number) => Promise<boolean>;
  publicUrl?: () => Promise<string | null>;
  log?: (line: string) => void;
  waitMs?: number;
}
```

- [ ] **Step 1: Write the failing tests**

`tests/lifecycle-local.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocal, type LocalOpts } from "@server/lifecycle/local";
import { writeState } from "@server/lifecycle/state";
import { ServiceError, type ServiceManager, type ServiceSpec } from "@server/lifecycle/service/types";

const alive = { isAlive: () => true, argsOf: () => "paddock" };
const rec = { pid: 4242, args: "paddock", port: 8787, version: "0.9.0", startedAt: 1 };

function fakeManager(over: Partial<ServiceManager> = {}) {
  const installed: ServiceSpec[] = [];
  const m: ServiceManager = {
    kind: "systemd",
    unitPath: "/path/to/userhome/.config/systemd/user/paddock.service",
    logHint: "journalctl --user -u paddock",
    startsAt: async () => "boot",
    install: async (s) => { installed.push(s); return { warnings: [] }; },
    uninstall: async () => {},
    inspect: async () => "active",
    ...over,
  };
  return { m, installed };
}

async function go(over: Partial<LocalOpts> & { manager?: ServiceManager }) {
  const lines: string[] = [];
  const dir = over.dir ?? await mkdtemp(join(tmpdir(), "paddock-local-"));
  const code = await runLocal({
    dir, port: 8787,
    service: { ok: true, manager: over.manager ?? fakeManager().m },
    argv: ["/path/to/paddock"],
    env: { HOME: "/path/to/userhome", PADDOCK_SERVICE: "systemd" },
    probe: alive,
    listener: async () => null,
    healthCheck: async () => true,
    publicUrl: async () => null,
    log: (l) => lines.push(l),
    waitMs: 300,
    ...over,
  });
  return { code, out: lines.join("\n") };
}

test("a fresh install registers, waits for health, and reports where it starts", async () => {
  const { m, installed } = fakeManager();
  const r = await go({ manager: m });
  expect(r.code).toBe(0);
  expect(installed).toEqual([{ argv: ["/path/to/paddock"], env: { HOME: "/path/to/userhome", PADDOCK_SERVICE: "systemd" } }]);
  expect(r.out).toContain("systemd service");
  expect(r.out).toContain("starts at boot");
  expect(r.out).toContain("paddock.service");
  // Names, never values: the captured env can hold paths worth not echoing.
  expect(r.out).toContain("HOME PADDOCK_SERVICE");
  expect(r.out).not.toContain("/path/to/userhome\n");
  expect(r.out).toContain("paddock start"); // the phone-access hint
});

test("an unsupported platform is refused with its reason", async () => {
  const r = await go({ service: { ok: false, reason: "needs systemd or launchd; this is win32" } });
  expect(r.code).toBe(1);
  expect(r.out).toContain("win32");
});

test("a foreground paddock already running is refused — no second one on the port", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-local-"));
  await writeState(dir, rec);
  const { m, installed } = fakeManager();
  const r = await go({ dir, manager: m });
  expect(r.code).toBe(1);
  expect(installed).toEqual([]);
  expect(r.out).toContain("pid 4242");
  expect(r.out).toContain("paddock stop && paddock local");
});

test("an untracked paddock on the port is refused too", async () => {
  const { m, installed } = fakeManager();
  const r = await go({ manager: m, listener: async () => ({ version: "0.8.0" }) });
  expect(r.code).toBe(1);
  expect(installed).toEqual([]);
});

test("re-running over the service's OWN instance refreshes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-local-"));
  await writeState(dir, { ...rec, managedBy: "systemd" });
  const { m, installed } = fakeManager();
  const r = await go({ dir, manager: m, listener: async () => ({ version: "0.9.0" }) });
  expect(r.code).toBe(0);
  expect(installed.length).toBe(1);
});

test("a ServiceError is reported in one line, exit 1", async () => {
  const { m } = fakeManager({ install: async () => { throw new ServiceError("systemd has no user session here (No medium found)"); } });
  const r = await go({ manager: m });
  expect(r.code).toBe(1);
  expect(r.out).toContain("No medium found");
});

test("linger refused: success, but the warning and 'login' are both said", async () => {
  const { m } = fakeManager({
    install: async () => ({ warnings: ["could not enable linger (Access denied) — To fix: sudo loginctl enable-linger operator"] }),
    startsAt: async () => "login",
  });
  const r = await go({ manager: m });
  expect(r.code).toBe(0);
  expect(r.out).toContain("Access denied");
  expect(r.out).toContain("starts at login");
  expect(r.out).not.toContain("starts at boot");
});

test("registered but not answering: exit 1, says it keeps retrying and where to look", async () => {
  const r = await go({ healthCheck: async () => false });
  expect(r.code).toBe(1);
  expect(r.out).toContain("registered");
  expect(r.out).toContain("herdr");
  expect(r.out).toContain("journalctl --user -u paddock");
});

test("unreadable state is a refusal, not a guess", async () => {
  const { m, installed } = fakeManager();
  const dir = await mkdtemp(join(tmpdir(), "paddock-local-"));
  await Bun.write(join(dir, "paddock.state.json"), "{not json");
  const r = await go({ dir, manager: m });
  expect(r.code).toBe(1);
  expect(installed).toEqual([]);
});
```

(If `checkState` reports a non-JSON file as `stale`/`none` rather than `unreadable`, look at how `tests/lifecycle-status.test.ts` produces the `unreadable` case and copy that setup into the last test.)

Append to `tests/cli.test.ts` (in the parseArgs section):

```ts
test("local is a command, and USAGE names it", () => {
  expect(parseArgs(["local"]).command).toBe("local");
  expect(USAGE).toContain("paddock local");
});
```

In `tests/tunnel-hints.test.ts`, add:

```ts
test("the detached hint points at `paddock start`, which publishes without a restart", () => {
  expect(tunnelHint(null, true)).toContain("paddock start");
  expect(tunnelHint(null, true)).not.toContain("stop it");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/lifecycle-local.test.ts tests/cli.test.ts tests/tunnel-hints.test.ts`
Expected: FAIL — `local.ts` missing, `local` parses as `unknown`, hint says "stop it".

- [ ] **Step 3: Implement**

`src/server/lifecycle/commands.ts`: change `async function defaultHealthCheck` to `export async function defaultHealthCheck`.

`src/server/tunnel/preflight.ts`, in `tunnelHint`:

```ts
  return detached
    ? "  for phone access: `paddock start` — it publishes this one, no restart"
    : "  to reach this from your phone: `paddock tunnel`";
```

and update its doc comment's first line to "printed by `paddock` and `paddock local`".

`src/server/lifecycle/local.ts`:

```ts
import {
  defaultHealthCheck, httpListener, type Listener,
} from "@server/lifecycle/commands";
import type { ServiceChoice } from "@server/lifecycle/service";
import { ServiceError } from "@server/lifecycle/service/types";
import { checkState, type Probe } from "@server/lifecycle/state";
import { SettingsStore } from "@server/settings/store";
import { glyph, say } from "@server/term";
import { tunnelHint } from "@server/tunnel/preflight";

export interface LocalOpts {
  dir: string;
  port: number;
  service: ServiceChoice;
  argv: string[];
  env: Record<string, string>;
  probe?: Probe;
  listener?: Listener;
  healthCheck?: (port: number) => Promise<boolean>;
  publicUrl?: () => Promise<string | null>;
  log?: (line: string) => void;
  waitMs?: number;
}

/**
 * `paddock local` — a localhost paddock the OS keeps running, through reboots.
 *
 * The reason it exists: a named tunnel in front of port 8787 is only as alive
 * as the paddock behind it, and nothing used to bring that paddock back after
 * a restart. See docs/design/2026-10-05-start-tunnel-local-service-design.md.
 *
 * Success is `/api/health` answering, not a unit file written — `runStart`'s
 * old rule, for the same reason.
 */
export async function runLocal(o: LocalOpts): Promise<number> {
  const log = o.log ?? say;
  if (!o.service.ok) {
    log(`paddock: ${o.service.reason}`);
    return 1;
  }
  const m = o.service.manager;

  const got = await checkState(o.dir, o.probe);
  if (got.kind === "unreadable") {
    log(`paddock: could not read state (${got.error}), refusing to guess — not registering`);
    return 1;
  }
  // The service's own instance is the one thing `local` may replace: that is
  // what makes a second run a refresh. Anything else on the port would leave
  // the service crash-looping against it.
  const ours = got.kind === "running" && got.state.managedBy !== undefined;
  if (got.kind === "running" && !ours) {
    log(`paddock: another paddock is already running (pid ${got.state.pid}, port ${got.state.port})`);
    log("  `paddock local` would start a second one on the same port. Stop it first:");
    log("    paddock stop && paddock local");
    return 1;
  }
  if (!ours && (await (o.listener ?? httpListener)(o.port)) !== null) {
    log(`paddock: a paddock no record describes is serving on port ${o.port} — not registering a second one`);
    log("  `paddock status` shows what is known about it");
    return 1;
  }

  let warnings: string[];
  try {
    ({ warnings } = await m.install({ argv: o.argv, env: o.env }));
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    log(`paddock: ${e.message}`);
    return 1;
  }
  for (const w of warnings) log(`${glyph("unknown")} ${w}`);

  const health = o.healthCheck ?? defaultHealthCheck;
  const deadline = Date.now() + (o.waitMs ?? 15_000);
  let up = false;
  while (!up && Date.now() < deadline) {
    up = await health(o.port);
    if (!up) await Bun.sleep(200);
  }

  if (!up) {
    log(`${glyph("no")} paddock — registered as a ${m.kind} service, but not answering on port ${o.port} yet`);
    log("  it keeps retrying on its own; the usual cause is herdr not running yet");
    log(`  its output: ${m.logHint}`);
    log(`  unit: ${m.unitPath}`);
    return 1;
  }

  const when = await m.startsAt();
  log(`${glyph("yes")} paddock — running as a ${m.kind} service on 127.0.0.1:${o.port}`);
  log(`    starts at ${when} · output: ${m.logHint}`);
  log(`    unit: ${m.unitPath}`);
  log(`    captured: ${Object.keys(o.env).sort().join(" ")}`);
  const url = o.publicUrl ? await o.publicUrl() : await savedPublicUrl(o.dir);
  const hint = tunnelHint(url, true);
  if (hint !== null) log(hint);
  return 0;
}

async function savedPublicUrl(dir: string): Promise<string | null> {
  const s = new SettingsStore(dir);
  await s.load();
  return s.current().publicUrl;
}
```

(If `SettingsStore.current().publicUrl`'s type is `string | undefined`, coerce with `?? null`.)

`src/server/cli.ts`:
- Add `"local"` to the `Command` union and to the doc comment's list of implemented verbs.
- In `commandFor`: `if (verb === "local") return "local";`
- Replace `USAGE` with:

```ts
export const USAGE = [
  "usage: paddock [--demo]          start the dashboard in the foreground",
  "       paddock start [--for D]   publish it on a quick tunnel, in the background",
  "                                 (publishes the paddock already running here, if any)",
  "       paddock local             run it on localhost as a service; survives reboots",
  "       paddock stop [--force]    stop the tunnel and paddock; removes the service",
  "       paddock status            is it running?",
  "       paddock update [--check]  install the latest release",
  "       paddock doctor            can this paddock talk to your herdr?",
  "       paddock tunnel [--for D]  publish it on a quick tunnel, in the foreground",
  "       paddock tunnel --detach   the same, in the background (what `start` runs)",
  "       paddock tunnel --publish-running",
  "                                 publish the paddock already running here",
  "                                 D is 30m, 2h or 7d",
  "       paddock pair              the URL, code and QR of the running tunnel",
  "       paddock help | --help     print this",
  "       paddock --version | -V    print the version",
].join("\n");
```

`src/server/index.ts`, directly after the `status` block (imports: `runLocal` from `@server/lifecycle/local`, `serviceManager` from `@server/lifecycle/service`, `serviceArgv` from `@server/lifecycle/service/argv`, `serviceEnv` from `@server/lifecycle/service/env`):

```ts
// Before any server setup, like `status`: `local` hands the serving to the
// service manager and only waits for it. The paddock it registers is a plain
// `paddock` with no verb, started by systemd/launchd, not by this process.
if (command === "local") {
  const dir = defaultConfigDir();
  const service = serviceManager({ configDir: dir });
  process.exit(await runLocal({
    dir,
    port: PORT,
    service,
    argv: serviceArgv(),
    env: service.ok ? serviceEnv(process.env, service.manager.kind) : {},
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/lifecycle-local.test.ts tests/cli.test.ts tests/tunnel-hints.test.ts && make check`
Expected: PASS. (`cli.test.ts`'s "usage line names every implemented verb" may need `paddock local` added to its list.)

- [ ] **Step 5: Commit**

```bash
make check-clean && make test
git add src/server/lifecycle/local.ts src/server/lifecycle/commands.ts src/server/cli.ts src/server/index.ts src/server/tunnel/preflight.ts tests/lifecycle-local.test.ts tests/cli.test.ts tests/tunnel-hints.test.ts
git commit -m "feat: paddock local — a localhost paddock the OS keeps running"
```

---

### Task 6: `stop` and `status` know the service

**Files:**
- Modify: `src/server/lifecycle/commands.ts` (`StatusOpts`, `runStatus`, `StopOpts`, `runStop`, `stopPaddock`'s last parameter), `src/server/index.ts` (status/stop dispatch)
- Test: extend `tests/lifecycle-stop.test.ts`, `tests/lifecycle-status.test.ts`

**Interfaces:**
- Consumes: `ServiceChoice`, `ServiceError`.
- Produces: `StatusOpts.service?: ServiceChoice`, `StopOpts.service?: ServiceChoice`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lifecycle-stop.test.ts` (add imports: `ServiceError, type ServiceManager` from `@server/lifecycle/service/types`):

```ts
function svc(status: "absent" | "registered" | "active", over: Partial<ServiceManager> = {}) {
  const calls: string[] = [];
  const manager: ServiceManager = {
    kind: "systemd", unitPath: "/path/to/unit", logHint: "journalctl --user -u paddock",
    startsAt: async () => "boot",
    install: async () => ({ warnings: [] }),
    uninstall: async () => { calls.push("uninstall"); },
    inspect: async () => status,
    ...over,
  };
  return { service: { ok: true as const, manager }, calls };
}

test("a registered service is uninstalled, and the supervised pid is never signalled", async () => {
  // SIGTERM to a supervised process is the race where it comes straight back.
  const d = await dir();
  const { service, calls } = svc("active");
  const sent: string[] = [];
  const lines: string[] = [];
  // After uninstall the process is gone and has removed its own record.
  const code = await runStop({
    dir: d, service,
    probe: { isAlive: () => false, argsOf: () => null },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: (l) => lines.push(l), waitMs: 300,
  });
  expect(code).toBe(0);
  expect(calls).toEqual(["uninstall"]);
  expect(sent).toEqual([]);
  expect(lines.join("\n")).toContain("removed from systemd");
  // Not followed by a contradicting "not running" line.
  expect(lines.join("\n")).not.toContain("paddock — not running");
});

test("a registered-but-dead service (crash loop) is still uninstalled", async () => {
  const d = await dir();
  const { service, calls } = svc("registered");
  const code = await runStop({ dir: d, service, log: () => {}, waitMs: 300 });
  expect(code).toBe(0);
  expect(calls).toEqual(["uninstall"]);
});

test("an uninstall failure is reported, exits 1, and signals nothing", async () => {
  const d = await dir();
  await writeState(d, { ...s, managedBy: "systemd" });
  const { service } = svc("active", { uninstall: async () => { throw new ServiceError("`systemctl --user stop paddock.service` failed: no bus"); } });
  const sent: string[] = [];
  const lines: string[] = [];
  const code = await runStop({
    dir: d, service, probe: { isAlive: () => true, argsOf: () => "paddock" },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`), log: (l) => lines.push(l), waitMs: 300,
  });
  expect(code).toBe(1);
  expect(sent).toEqual([]);
  expect(lines.join("\n")).toContain("no bus");
});

test("no service registered: stop behaves exactly as before", async () => {
  const d = await dir();
  await writeState(d, s);
  const { service, calls } = svc("absent");
  const sent: string[] = [];
  const { probe } = dyingProbe(1, "paddock");
  const code = await runStop({ dir: d, service, probe, signal: (pid, sig) => sent.push(`${sig}->${pid}`), log: () => {}, waitMs: 500 });
  expect(code).toBe(0);
  expect(calls).toEqual([]);
  expect(sent).toEqual(["SIGTERM->4242"]);
});
```

Append to `tests/lifecycle-status.test.ts` (reuse that file's existing helpers for dir/probe; the `svc` helper above is repeated here verbatim since test files do not share it — copy it in):

```ts
test("status names an active service and where it starts", async () => {
  const d = await mkdtemp(join(tmpdir(), "paddock-status-svc-"));
  await writeState(d, { pid: 4242, args: "paddock", port: 8787, version: "0.9.0", startedAt: Date.now(), managedBy: "systemd" });
  const { service } = svc("active");
  const lines: string[] = [];
  const code = await runStatus({ dir: d, service, probe: { isAlive: () => true, argsOf: () => "paddock" }, log: (l) => lines.push(l) });
  expect(code).toBe(0);
  expect(lines.join("\n")).toContain("service: systemd · starts at boot");
});

test("status names a registered service that is not serving, and where to look", async () => {
  const d = await mkdtemp(join(tmpdir(), "paddock-status-svc-"));
  const { service } = svc("registered");
  const lines: string[] = [];
  const code = await runStatus({ dir: d, service, log: (l) => lines.push(l) });
  expect(code).toBe(1);
  expect(lines.join("\n")).toContain("registered");
  expect(lines.join("\n")).toContain("journalctl --user -u paddock");
});

test("no service: status prints no service line", async () => {
  const d = await mkdtemp(join(tmpdir(), "paddock-status-svc-"));
  const { service } = svc("absent");
  const lines: string[] = [];
  await runStatus({ dir: d, service, log: (l) => lines.push(l) });
  expect(lines.join("\n")).not.toContain("service");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/lifecycle-stop.test.ts tests/lifecycle-status.test.ts`
Expected: FAIL — `service` not accepted / not acted on.

- [ ] **Step 3: Implement**

In `commands.ts` add imports `import type { ServiceChoice } from "@server/lifecycle/service";` and `import { ServiceError } from "@server/lifecycle/service/types";`. Add `service?: ServiceChoice;` to both `StatusOpts` and `StopOpts`, each with the comment `/** The `paddock local` service, if this platform has one. Injected for tests. */`.

`runStatus` — between the paddock and tunnel reports:

```ts
  const paddock = await reportPaddock(o, log, now);
  await reportService(o.service, log);
  const tunnel = await reportTunnel(o, log, now);
```

and the new function, next to `reportTunnel`:

```ts
/**
 * The service half of `status`. Silent when nothing is registered, for the
 * reason `reportTunnel` is: most machines have none.
 */
async function reportService(
  service: ServiceChoice | undefined,
  log: (line: string) => void,
): Promise<void> {
  if (service === undefined || !service.ok) return;
  const m = service.manager;
  const got = await m.inspect();
  if (got === "absent") return;
  if (got === "active") {
    log(`    service: ${m.kind} · starts at ${await m.startsAt()} · output: ${m.logHint}`);
    return;
  }
  log(`${glyph("no")} service — registered (${m.kind}) but not serving; it keeps retrying`);
  log(`    the usual cause is herdr not running · output: ${m.logHint}`);
}
```

`runStop` — after the tunnel block:

```ts
  const tunnel = await stopTunnel({ dir: o.dir, probe, log, signal: o.signal, waitMs });

  /**
   * THE SERVICE GOES BEFORE ANY SIGNAL. A supervised paddock that is merely
   * SIGTERMed is still registered and starts again at the next boot — the
   * opposite of what `stop` promises. Stopping it through its manager is also
   * the only way that does not race the manager. If that fails, nothing is
   * signalled: the operator gets the manager's own error instead.
   */
  const svc = await stopService(o.service, log);
  if (svc.code !== 0) return svc.code;

  const paddock = await stopPaddock(
    o, log, send, probe, waitMs, tunnel.stoppedServing || svc.stopped,
  );
```

Rename `stopPaddock`'s last parameter from `tunnelWasServing` to `alreadyReported` and update its doc comment to "A tunnel serving the dashboard, or the service, was just stopped — the 'not running' line would contradict it." Update its single use in the `"none"` case accordingly.

New function, next to `stopPaddock`:

```ts
async function stopService(
  service: ServiceChoice | undefined,
  log: (line: string) => void,
): Promise<{ code: number; stopped: boolean }> {
  if (service === undefined || !service.ok) return { code: 0, stopped: false };
  const m = service.manager;
  if ((await m.inspect()) === "absent") return { code: 0, stopped: false };
  try {
    await m.uninstall();
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    log(`paddock: ${e.message}`);
    log(`  nothing signalled — a supervised paddock would only be restarted. Unit: ${m.unitPath}`);
    return { code: 1, stopped: false };
  }
  log(`${glyph("yes")} paddock — stopped, and removed from ${m.kind}; it will not start at boot`);
  return { code: 0, stopped: true };
}
```

`src/server/index.ts` — `status` and `stop` dispatch each pass `service: serviceManager({ configDir: defaultConfigDir() })`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/lifecycle-stop.test.ts tests/lifecycle-status.test.ts && make check`
Expected: PASS, including every pre-existing test in both files (they pass no `service`, so nothing changes for them).

- [ ] **Step 5: Commit**

```bash
make check-clean && make test
git add src/server/lifecycle/commands.ts src/server/index.ts tests/lifecycle-stop.test.ts tests/lifecycle-status.test.ts
git commit -m "feat: stop removes the local service; status reports it"
```

---

### Task 7: `start` is the detached tunnel

**Files:**
- Create: `src/server/lifecycle/start.ts`
- Modify: `src/server/index.ts` (remove the `runStart` dispatch, ~line 181; widen the tunnel block, ~line 205), `src/server/lifecycle/commands.ts` (delete `runStart`, `StartOpts`; fix the `ConfigDirUnusable` comment that names `runStart` to name `runDetach`), `src/server/update.ts` (~line 383), the `running` callback in `index.ts`'s `update` dispatch
- Delete: `tests/lifecycle-start.test.ts`
- Test: `tests/lifecycle-start-route.test.ts`, `tests/cli.test.ts` (replace the `start` spawn test), `tests/update.test.ts`

**Interfaces:**
- Consumes: `StateCheck`, `ServiceStatus`.
- Produces: `type StartRoute = { kind: "publish-running" } | { kind: "serve" } | { kind: "refuse"; message: string }`, `startRoute(state: StateCheck, service: ServiceStatus): StartRoute`. `UpdateOpts.running` result gains `managedBy?: ServiceKind`.

- [ ] **Step 1: Write the failing tests**

`tests/lifecycle-start-route.test.ts`:

```ts
import { expect, test } from "bun:test";
import { startRoute } from "@server/lifecycle/start";

const rec = { pid: 1, args: "paddock", port: 8787, version: "0.9.0", startedAt: 1 };

test("a paddock already serving is published, not duplicated", () => {
  expect(startRoute({ kind: "running", state: rec }, "absent").kind).toBe("publish-running");
  expect(startRoute({ kind: "running", state: { ...rec, managedBy: "systemd" } }, "active").kind)
    .toBe("publish-running");
});

test("nothing running and no service: start serves its own", () => {
  expect(startRoute({ kind: "none" }, "absent").kind).toBe("serve");
  expect(startRoute({ kind: "stale", state: rec }, "absent").kind).toBe("serve");
});

test("a registered service that is not serving yet is a refusal naming herdr", () => {
  // Serving our own here would fight the service for the port the moment
  // herdr comes up.
  const r = startRoute({ kind: "none" }, "registered");
  expect(r.kind).toBe("refuse");
  expect(r.kind === "refuse" && r.message).toContain("herdr");
  expect(r.kind === "refuse" && r.message).toContain("paddock local");
});

test("unreadable state falls through to serve, where preflight reports it", () => {
  expect(startRoute({ kind: "unreadable", error: "EACCES" }, "absent").kind).toBe("serve");
});
```

In `tests/cli.test.ts`:
1. Change `runVerb`'s signature to `runVerb(verb: string, extraArgs: string[] = [], extraEnv: Record<string, string> = {})`, spread `...extraEnv` LAST into its `env`, and also add these two lines to its env, with this comment:

```ts
      // No user bus: `status`/`stop`/`start` now ask systemd about the
      // `paddock local` unit, and the developer's real one must not decide
      // this file's outcome — the same reason PADDOCK_PORT is randomised.
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
      XDG_CONFIG_HOME: CONFIG,
```

2. Replace the test `"start's own parsing process never binds a port, whatever the detached child does"` with:

```ts
test("start is the detached tunnel: with no cloudflared it refuses at the terminal, binding nothing", () => {
  // `start` now runs `tunnel --detach`, so it goes through preflight — and an
  // empty PATH means no cloudflared, the cheapest refusal there is. This also
  // keeps the test from ever opening a real public URL.
  const r = runVerb("start", [], { PATH: "" });
  expect(r.timedOut, "paddock start never exited — it is serving").not.toBe(true);
  expect(r.code).not.toBe(0);
  expect(r.out + r.err).not.toContain("paddock listening");
  expect(r.out + r.err).toContain("cloudflared is not installed");
});
```

If `Bun.spawnSync(["bun", ...])` cannot find bun with `PATH: ""`, change `runVerb`'s argv[0] from `"bun"` to `process.execPath`.

In `tests/update.test.ts`, replace the `"paddock stop && paddock start"` assertions:
- First test: `expect(text).toContain("paddock stop");` and `expect(text).toContain("paddock local");`
- Add:

```ts
test("a service-managed instance is told to re-run `paddock local`, which restarts it", async () => {
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  const said: string[] = [];
  await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: (l) => said.push(l),
    running: async () => ({ pid: 3558072, port: 8787, version: "0.1.0", managedBy: "systemd" }),
  });
  const text = said.join("\n");
  expect(text).toContain("paddock local");
  expect(text).not.toContain("paddock stop");
});
```

- The "already new" test: `expect(said.join("\n")).not.toContain("restart it");`

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/lifecycle-start-route.test.ts tests/cli.test.ts tests/update.test.ts`
Expected: FAIL — module missing; `start` still runs `runStart`; update text unchanged.

- [ ] **Step 3: Implement**

`src/server/lifecycle/start.ts`:

```ts
import type { ServiceStatus } from "@server/lifecycle/service/types";
import type { StateCheck } from "@server/lifecycle/state";

export type StartRoute =
  | { kind: "publish-running" }
  | { kind: "serve" }
  | { kind: "refuse"; message: string };

/**
 * What `paddock start` does. It is always the detached tunnel; the only
 * question is whether that tunnel serves its own dashboard or publishes one
 * already here.
 *
 * A running paddock — `paddock local` after a reboot, or a foreground one — is
 * published: a second paddock would mean a second herdr connection and every
 * blocked agent notifying twice (see `tunnel/preflight.ts`).
 *
 * A REGISTERED service that is not serving is refused rather than served
 * around: it is waiting for herdr, and the moment herdr appears it would fight
 * our paddock for the port.
 */
export function startRoute(state: StateCheck, service: ServiceStatus): StartRoute {
  if (state.kind === "running") return { kind: "publish-running" };
  if (service !== "absent") {
    return {
      kind: "refuse",
      message: [
        "paddock: `paddock local` is registered but not serving yet",
        "  `paddock start` would bring up a second paddock that fights it for the port.",
        "  The usual cause is herdr not running: start herdr, then run `paddock start` again.",
        "  `paddock status` shows the service; `paddock stop` removes it.",
      ].join("\n"),
    };
  }
  return { kind: "serve" };
}
```

`src/server/index.ts`:
- Delete the `if (command === "start") { process.exit(await runStart(...)); }` block and the `runStart` import, and the now-orphaned comment above `pair` that describes `start` spawning a child (move the `pair` doc comment so it still sits on the `pair` block).
- Change `if (command === "tunnel") {` (the FIRST one, ~line 205) to `if (command === "tunnel" || command === "start") {`. Leave the later `command === "tunnel" && tunnelPublishRunning` and bottom `command === "tunnel"` checks alone — `start` always exits inside `runDetach` before reaching them.
- Replace `tunnelPublishRunning = flags.has("--publish-running");` with:

```ts
  tunnelPublishRunning = flags.has("--publish-running");

  // `start` is `tunnel --detach` that chooses `--publish-running` itself. See
  // `lifecycle/start.ts` for the three cases.
  if (command === "start") {
    const service = serviceManager({ configDir: defaultConfigDir() });
    const route = startRoute(
      await checkState(defaultConfigDir()),
      service.ok ? await service.manager.inspect() : "absent",
    );
    if (route.kind === "refuse") {
      warn(route.message);
      process.exit(1);
    }
    if (route.kind === "publish-running") tunnelPublishRunning = true;
  }
```

- Change `if (flags.has("--detach")) {` to `if (flags.has("--detach") || command === "start") {`.
- In the `update` dispatch's `running` callback, return `managedBy: got.state.managedBy` too.

`src/server/lifecycle/commands.ts`: delete `StartOpts` and `runStart`. Keep `defaultHealthCheck`, `spawnDetached`, `logFile`, `readLogTail`, `childCommand`, `ConfigDirUnusable`. Remove imports that become unused (`SettingsStore`, `tunnelHint` if only `runStart` used them — `make check` will tell you).

`src/server/update.ts` — the `running` type gains `managedBy?: ServiceKind` (import the type), and the hint becomes:

```ts
    log("  restart it to pick this up:");
    if (live.managedBy !== undefined) {
      // Re-running `local` rewrites the unit and restarts the service onto
      // the new binary. `stop` would REMOVE the service, which is not a restart.
      log("    paddock local");
    } else {
      log("    paddock stop, then start it again the way you did:");
      log("    `paddock local`, `paddock start` or `paddock`");
    }
```

Delete `tests/lifecycle-start.test.ts` (`git rm`). Its subject, `runStart`, no longer exists; the "success is health, not a spawn" rule it pinned now lives in `runDetach` (tests/tunnel-detach.test.ts) and `runLocal` (Task 5).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/lifecycle-start-route.test.ts tests/cli.test.ts tests/update.test.ts tests/tunnel-detach.test.ts && make check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
make check-clean && make test
git add -A src/server tests
git status --short   # confirm only intended files; no dist-* output
git commit -m "feat!: paddock start publishes on a quick tunnel

The old localhost meaning of start moves to paddock local. start runs
tunnel --detach and publishes a paddock already serving here instead of
starting a second one."
```

---

### Task 8: Docs

**Files:**
- Modify: `README.md` (~line 138 command block), `docs/running-locally.md` (lines ~39–62), `docs/decisions.md` (append decision 33), `docs/roadmap.md`, `docs/architecture.md` (module table), `docs/design/2026-10-05-start-tunnel-local-service-design.md` (Restart refinement + start refusal), `docs/design/2026-08-19-lifecycle-commands-design.md` (one-line pointer under "Not systemd or launchd")

- [ ] **Step 1: README command block** — replace the `paddock start      # detached` line and its neighbours so the block reads:

```bash
paddock start      # phone access: a quick tunnel, in the background
paddock local      # localhost, as a service — comes back after a reboot
paddock status
paddock stop       # closes the tunnel, stops paddock, removes the service
```

Read the surrounding prose and fix any sentence that still says `start` is localhost.

- [ ] **Step 2: `docs/running-locally.md`** — replace the section from "Once a tunnel is in front of it, `paddock start` is the normal way…" through the "`Type=forking` unit…" paragraph with:

```markdown
Once a named tunnel is in front of it, `paddock local` is the normal way to
run it: it registers paddock as a user service — a systemd user unit on Linux,
a launchd agent on macOS — so it comes back after a crash and after a reboot,
and the tunnel finds it on the same port.

```bash
paddock local     # register, start, wait until it answers
paddock status    # pid, port, uptime, and the service line
paddock stop      # stops it AND removes it from boot
```

On Linux it starts at **boot**, before anyone logs in, if linger is on;
`paddock local` turns linger on and tells you plainly when it could not (some
distros need `sudo loginctl enable-linger $USER`). On macOS a LaunchAgent can
only start at **login**, and `paddock local` says so.

The unit runs plain `paddock` in the foreground with a snapshot of `PATH`,
`HOME`, `HERDR_*` and `PADDOCK_*` taken when you ran `paddock local`. Change
one of those? Run `paddock local` again — it rewrites the unit and restarts
the service. Output goes to `journalctl --user -u paddock` (Linux) or
`~/.config/paddock/paddock.log` (macOS).

After a reboot, herdr is usually not running until you start it. paddock
exits while it cannot reach herdr and the service manager restarts it every
ten seconds; your phone sees the tunnel's error page until herdr is up, then
everything connects on its own.

No named tunnel? `paddock start` publishes on a quick tunnel instead, in the
background — and if `paddock local` is already serving, it publishes that one.
```

- [ ] **Step 3: `docs/decisions.md`** — append:

```markdown
33. **paddock manages its own user service, reversing "Not systemd or
    launchd".** The lifecycle design (2026-08-19) declined service units for a
    tool run beside herdr on a laptop, and ended "Revisit if anyone asks to run
    paddock on an always-on box". That ask came: a named tunnel in front of
    port 8787 is only as alive as the paddock behind it, and nothing brought
    that paddock back after a reboot. The objection was vocabulary — `stop`
    becoming `systemctl --user stop paddock` — so paddock keeps its own:
    `paddock local` writes and enables the unit, `stop` removes it, `status`
    reports it. `stop` UNINSTALLS rather than only stopping, so nothing
    `stop` was told to stop comes back at boot. Restart is on-failure, not
    always: paddock exits 1 while herdr is unreachable (the after-boot case)
    and 0 on SIGTERM, which must stay down. At the same time `start` became
    the detached quick tunnel — the verb people reach for first now gives
    phone access — and the old localhost `start` moved to `local`. See
    `docs/design/2026-10-05-start-tunnel-local-service-design.md`.
```

- [ ] **Step 4: `docs/roadmap.md`** — add an entry:

```markdown
- **A "herdr is not running" screen for a service paddock.** After a reboot
  `paddock local`'s service crash-loops (on-failure, every 10s) until herdr is
  started, and the phone sees the tunnel's 502. Serving the UI with a plain
  "herdr is not running on this machine" state instead is a change to startup
  (`herdr/await-start.ts` is bounded on purpose) and was kept out of the
  2026-10-05 service work.
```

Also find the roadmap paragraph at ~line 410 ("the bare binary ships no unit file, so a shipped systemd unit remains the honest answer") and append: "— shipped as `paddock local`, decision 33."

- [ ] **Step 5: `docs/architecture.md`** — add rows to the server module table for `lifecycle/service/` ("the `paddock local` service behind one `ServiceManager`; systemd and launchd; every shell-out through an injected `Run`"), `lifecycle/local.ts`, and `lifecycle/start.ts`, matching the existing rows' style. Update the `update-check.ts` row's "the long-lived case is the whole point of `paddock start`" to "`paddock local`".

- [ ] **Step 6: The spec and the old design** — in the spec, change `Restart=always` to `Restart=on-failure` (and launchd `KeepAlive` to `SuccessfulExit=false`) with one sentence of reason, and add to the `start` bullet: "If the `local` service is registered but not serving, `start` refuses (herdr down) rather than serving a paddock that would fight it for the port." In `2026-08-19-lifecycle-commands-design.md`, under "Not systemd or launchd", add: "> Reversed 2026-10-05 — see decision 33."

- [ ] **Step 7: Verify and commit**

```bash
grep -rn "paddock start" README.md docs/*.md src/server | grep -v "docs/design/2026-08\|docs/plans"
```

Expected: every hit means the tunnel. Fix any that still mean localhost.

```bash
make check-clean && make test
git add README.md docs
git commit -m "docs: start publishes, local survives a reboot (decision 33)"
```

---

### Task 9: Manual verification from a used state

This touches the operator's REAL user session (a real unit, linger). **Ask the operator before starting it**, and say which port/config dir will be used. The installed release may be serving on 8787 (see the project memory on two binaries) — use `PADDOCK_PORT=8797` and `PADDOCK_CONFIG_DIR=$(mktemp -d)` for every command so nothing collides with it. Note these get captured into the unit, which is correct.

- [ ] **Step 1:** `export PADDOCK_PORT=8797 PADDOCK_CONFIG_DIR=$(mktemp -d)`; `bun src/server/index.ts local`. Expect `✓ … systemd service`, `starts at boot` (or the linger warning), the unit path, captured names.
- [ ] **Step 2: used state, not fresh.** Run `bun src/server/index.ts local` AGAIN. Expect success, and `systemctl --user show paddock -p ExecMainPID` to show a NEW pid (it restarted).
- [ ] **Step 3:** `systemctl --user kill -s SIGKILL paddock`; wait 12s; `curl -s 127.0.0.1:8797/api/health`. Expect it answered again (on-failure restart).
- [ ] **Step 4:** `bun src/server/index.ts status`. Expect the paddock line and `service: systemd · starts at boot`.
- [ ] **Step 5:** `bun src/server/index.ts start --for 30m`. Expect a trycloudflare URL, `publishing port 8797` in a following `status`.
- [ ] **Step 6:** `bun src/server/index.ts stop`. Expect tunnel stopped, `removed from systemd`, exit 0; then `systemctl --user list-unit-files paddock.service` lists nothing, `ls ~/.config/systemd/user/paddock.service` fails, `status` shows no service line.
- [ ] **Step 7:** Reboot survival, only if the operator agrees to a reboot: repeat Step 1, reboot, do NOT log in at the console, `curl` from another machine through the named tunnel or SSH in and `curl 127.0.0.1:8797/api/health`. Then `stop`. If no reboot is allowed, say so in the report — `systemctl --user restart` is not the same proof.
- [ ] **Step 8:** Report each step's actual output, including any that did not match.

---

## Self-review notes

- Spec coverage: command surface (Tasks 5, 7), service module (1–4), env snapshot (1), systemd incl. linger and journal (2), launchd (3), `managedBy` (4), stop/status (6), start publish-running (7), known gap (8 roadmap), testing incl. manual used-state check (9), docs (8). The two deliberate refinements are listed in Global Constraints and written back to the spec in Task 8.
- `runStart` removal: its health-not-spawn rule survives in `runDetach` and `runLocal`.
