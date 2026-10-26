# Tailscale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `paddock tailscale` publishes the running paddock service on the machine's tailnet HTTPS name, behind a loopback listener that admits only one Tailscale user.

**Architecture:** A config file `tailscale.json` (written only by the CLI) tells the `paddock local` service to bind a second loopback listener. That listener requires `Tailscale-User-Login` to equal the configured login before anything else runs. It serves the full app with its own same-origin allowlist (the shared list plus the ts.net host). `tailscale serve --bg` forwards tailnet HTTPS 443 to it. The CLI drives `tailscale` through the injectable `Run`, so tests never need a tailnet.

**Tech Stack:** Bun, TypeScript, Hono, `bun test`.

**Spec:** `docs/design/2026-10-26-tailscale-design.md` (approved). Read it first.

## Global Constraints

- **Public repo.** Fixtures, tests and docs use `dev-box`, `example-tailnet` (`dev-box.example-tailnet.ts.net`), and the login `operator@github`. Never use an `@example.com` login: `make check-clean` flags it. Run `make check-clean` before every commit.
- **Never `tailscale funnel`.** No code path may spawn it. A test asserts this (Task 4).
- The default `127.0.0.1:8787` listener must not read `Tailscale-User-*` headers, and its behaviour must not change.
- **Only the service binds the tailnet listener**: `serviceKindOf(process.env) !== undefined` (`src/server/lifecycle/service/env.ts`).
- **The tailnet listener binds `127.0.0.1` only**, regardless of `PADDOCK_HOST`. The port is `PADDOCK_TAILNET_PORT`, default `8789`.
- **Docker is out of scope**: preflight refuses when `/.dockerenv` or `/run/.containerenv` exists.
- **No swallowed errors** (CLAUDE.md). Every failure path either logs with a remedy or returns a non-zero exit code.
- `make test` (not bare `bun test`) for the full suite; `make check` for types.

**Refinement of the spec, decided here.** The spec sketched a `tailscale` group inside `settings.json`, "not writable through `PUT /api/settings`", and left the write mechanism to the builder. It is a **separate file**, `<configDir>/tailscale.json`, instead. The service keeps `settings.json` in memory and rewrites the whole file on every UI save, so a CLI write to a group inside it would be silently lost on the next save. A separate file avoids that, and it makes "the API cannot change it" structural, since no route knows the file exists. The service reads it at startup only, and the CLI restarts the service after writing it. This is "via restart" from the spec's live-vs-restart choice. Task 7 records this in `docs/settings.md`.

## Review Focus

1. **A forged identity header from a client.** The tailnet gate trusts only what `tailscale serve` sets. Task 8's live check must prove serve overwrites a client-sent `Tailscale-User-Login`. If it does not, stop and report back. Do not ship.
2. **Login case.** Tailscale logins are case-insensitive emails or `name@github`. A gate comparing case-sensitively 403s the operator after a provider changes case. Compare lowercased (Task 2 test `login match ignores case`).
3. **The serve port already in use.** An operator with another `tailscale serve` on 443 must not have it overwritten (Task 4 test `refuses when 443 serves something else`).
4. **Re-running `paddock tailscale` when it is already on.** It must re-verify and reprint, not error or duplicate (Task 5 test `second run is idempotent`).
5. **`paddock stop` leaving serve pointing at a dead port.** `stop` removes paddock's serve config, and only if that config targets our port (Task 6 tests).

---

### Task 1: `tailscale.json` config file

**Files:**
- Create: `src/server/tailscale/config.ts`
- Test: `tests/tailscale-config.test.ts`

**Interfaces:**
- Produces:
  - `interface TailscaleConfig { enabled: boolean; login: string; host: string }`
  - `tailscaleConfigFile(dir: string): string` (`join(dir, "tailscale.json")`)
  - `readTailscaleConfig(dir: string, log?: (m: string) => void): Promise<TailscaleConfig | null>`. Returns `null` when the file is absent, when it is invalid (logging why), or when `enabled` is false.
  - `writeTailscaleConfig(dir: string, c: TailscaleConfig): Promise<void>` (mode 0600, write to a temp file then rename)
  - `removeTailscaleConfig(dir: string): Promise<void>` (`rm` with `force`)

- [ ] **Step 1: Write failing tests**
  - `absent file → null, no log`
  - `round trip`: write `{enabled:true, login:"operator@github", host:"dev-box.example-tailnet.ts.net"}`, read it back equal
  - `invalid JSON → null and one log line naming the file`
  - `empty login or host → null and a log line`
  - `unknown key → null` (strict, same rule as settings)
  - `enabled:false → null`
  - `file mode is 0600`
- [ ] **Step 2:** `bun test tests/tailscale-config.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement in `config.ts`. Lowercase `login` on write.
- [ ] **Step 4:** Run the test again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tailscale): tailscale.json, written by the CLI only`

### Task 2: identity gate

**Files:**
- Create: `src/server/tailscale/gate.ts`
- Test: `tests/tailscale-gate.test.ts`

**Interfaces:**
- Produces:
  - `const LOGIN_HEADER = "tailscale-user-login"`
  - `tailnetRefusal(req: Request, allowedLogin: string): Response | null`. Returns `null` to admit. Otherwise returns `403` with JSON `{ ok: false, detail: "tailnet: <reason>" }`.
  - Reasons are exactly `no Tailscale identity on this request` and `Tailscale user <login> is not allowed here`.
  - `isTailnetRefusal(body: unknown): boolean` (`detail` starts with `tailnet: `). `status` uses it in Task 6.

- [ ] **Step 1: Write failing tests**
  - `admits the allowed login`
  - `login match ignores case`: allowed `operator@github`, header `Operator@GitHub` → admit
  - `refuses another login with 403 and names it`
  - `refuses a missing header`
  - `refuses an empty header`
  - `refuses for every path`: `/`, `/sw.js`, `/ws`, `/mcp`, `/api/agents/x/key`, all with no header
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Compare `trim().toLowerCase()` on both sides.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tailscale): identity gate for the tailnet listener`

### Task 3: tailnet listener, bound by the service only

**Files:**
- Create: `src/server/tailscale/listener.ts`
- Modify: `src/server/index.ts`, after the main `Bun.serve` (~:997-1015). It reads the config and starts the listener.
- Test: `tests/tailscale-listener.test.ts`

**Interfaces:**
- Consumes: `tailnetRefusal` (Task 2), `readTailscaleConfig` (Task 1), `tryUpgradeWs` and `hubWebSocket` (`src/server/ws/serve.ts`), `createApp(deps)` (`src/server/routes.ts`), `publicHostsFrom` (`src/server/origin.ts`).
- Produces:
  - `startTailnetListener(o: { app: { fetch(req: Request): Response | Promise<Response> }; websocket: WebSocketHandler<WsData>; port: number; login: string; publicHosts: () => readonly string[] }): { ok: true; port: number; stop(): void } | { ok: false; error: string }`.
  - It binds `hostname: "127.0.0.1"`. The fetch order is `tailnetRefusal`, then `tryUpgradeWs(req, server, o.publicHosts())`, then `o.app.fetch`. `EADDRINUSE` comes back as `{ok:false}` and is not thrown. Any other error rethrows.
  - `tailnetHosts(shared: readonly string[], host: string): readonly string[]` returns the shared list plus `host`, deduplicated.

- [ ] **Step 1: Write failing tests.** Use `port: 0` and a stub app that returns 200 `"app"`.
  - `forwards an allowed request to the app`
  - `403s a request without identity before the app runs`: assert the stub app was never called
  - `/ws upgrade with the allowed login and Origin https://dev-box.example-tailnet.ts.net and Host dev-box.example-tailnet.ts.net is upgraded`
  - `/ws without identity is 403 and never upgraded`
  - `tailnetHosts([], h) → [h]` and `tailnetHosts(["paddock.example.com"], h) → both`
  - `port in use → {ok:false}`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `listener.ts`.
- [ ] **Step 4: Wire `index.ts`.** Only when `serviceKindOf(process.env) !== undefined` and `command` is the serve path, read the config with `readTailscaleConfig(stateDir)`. When it is non-null:
  - build `tailnetApp = createApp({ ...appDeps, publicHosts: () => tailnetHosts(publicHosts(), cfg.host) })`;
  - start the listener on `Number(process.env.PADDOCK_TAILNET_PORT ?? 8789)`;
  - on `{ok:false}`, `warn` a line naming the port and that 8787 keeps serving, and do not exit;
  - on success, log `tailscale: listening on 127.0.0.1:<port> for https://<host> (allows <login>)`.
  The main `publicHosts` thunk is NOT changed.
- [ ] **Step 5:** Run the tests, then `make check`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(tailscale): identity-gated tailnet listener in the service`

### Task 4: `tailscale` CLI wrapper

**Files:**
- Create: `src/server/tailscale/cli.ts`
- Create: `tests/fixtures/tailscale-status.json` (invented: `Self.DNSName "dev-box.example-tailnet.ts.net."`, owner `operator@github`, `CertDomains ["dev-box.example-tailnet.ts.net"]`, `BackendState "Running"`)
- Test: `tests/tailscale-cli.test.ts`

**Interfaces:**
- Consumes: `Run` (`src/server/lifecycle/service/types.ts`).
- Produces:
  - `findTailscale(o?: { which?: (b: string) => string | null; platform?: NodeJS.Platform; exists?: (p: string) => boolean }): string | null`. Tries `which("tailscale")` first, then on darwin `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
  - `interface NodeInfo { running: boolean; host: string; login: string; certs: boolean }`
  - `readNode(run: Run, bin: string): Promise<{ ok: true; node: NodeInfo } | { ok: false; error: string }>`. It runs `status --json`. `host` is `Self.DNSName` without the trailing dot. `login` is `User[String(Self.UserID)].LoginName`, lowercased. `certs` is `CertDomains` non-empty.
  - `servedTarget(run: Run, bin: string): Promise<string | null>`. It runs `serve status --json` and returns the proxy target of the HTTPS 443 `/` handler, or null when 443 is not served.
  - `serveOn(run: Run, bin: string, port: number): Promise<void>` runs `[bin, "serve", "--bg", "--https=443", "http://127.0.0.1:<port>"]` through `must`.
  - `serveOff(run: Run, bin: string): Promise<void>` runs `[bin, "serve", "--https=443", "off"]` through `must`.
  - `ownsServe(target: string | null, port: number): boolean` is true only for `http://127.0.0.1:<port>` (and the `localhost` spelling).

- [ ] **Step 1: Write failing tests** (fake `Run` recording argv)
  - `findTailscale` covers `PATH` hit; darwin app-bundle fallback; linux miss → null
  - `readNode parses the fixture`: `host` without dot, `login`, `certs:true`
  - `readNode: no CertDomains → certs:false`, `BackendState NeedsLogin → running:false`
  - `readNode: non-zero exit → {ok:false} with stderr's first line`
  - `servedTarget` reads 443's proxy; null when there is no `Web` entry
  - `serveOn argv is exact`
  - `serveOff argv is exact`
  - `ownsServe` accepts only our port
  - `never funnel`: grep `src/server/tailscale/` sources for `"funnel"` and expect none
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Before writing the `serve status --json` parser, run `tailscale serve status --json` once on a real node to confirm its shape. Pin that shape in a fixture with invented names.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tailscale): wrapper around the tailscale CLI`

### Task 5: `paddock tailscale` / `paddock tailscale off`, and service restart

**Files:**
- Create: `src/server/tailscale/command.ts`
- Modify: `src/server/lifecycle/service/types.ts` (add `restart(): Promise<void>` to `ServiceManager`), `systemd.ts` (`systemctl --user restart <unit>`), `launchd.ts` (`launchctl kickstart -k gui/<uid>/paddock`)
- Modify: `src/server/cli.ts`
  - add `"tailscale"` to `Command` and `commandFor`
  - add `--login` to `VALUE_FLAGS`
  - add `args: string[]` (positionals after the verb) to `ParsedArgs`
  - add a USAGE line: `paddock tailscale [off]   publish on your tailnet (Tailscale)`
- Modify: `src/server/index.ts` to dispatch next to `pair` (~:199), before any herdr socket or bind
- Test: `tests/tailscale-command.test.ts`, `tests/cli.test.ts`, and the existing systemd/launchd service tests

**Interfaces:**
- Consumes: Tasks 1, 2 and 4; `checkState` / `httpListener` as used by `runStatus`; `serviceManager` from `src/server/lifecycle/service/index.ts`; `qrMatrix`, `qrLines`, `wantsQr` as in `src/server/tunnel/pair.ts:96-108`.
- Produces:
  - `runTailscale(o: TailscaleOpts): Promise<number>` and `runTailscaleOff(o: TailscaleOpts): Promise<number>`
  - `TailscaleOpts` contains `{ dir; port; tailnetPort; loginOverride?: string; service: ServiceChoice | undefined; run?: Run; find?: () => string | null; inContainer?: () => boolean; fetchHealth?: (url: string) => Promise<"paddock" | "gate" | string>; log?; colour?; columns?; rows? }`
  - `fetchHealth` returns `"paddock"` for a 200 health JSON, `"gate"` for a 403 that `isTailnetRefusal` recognises, and otherwise a description of what came back.

**`runTailscale` order**: each refusal logs the problem plus its fix and returns 1.
1. Refuse in a container.
2. Find `tailscale`, or print the install hint.
3. Read the node: must be `running` and have `certs` (otherwise point at admin console → DNS → HTTPS Certificates).
4. paddock must be running as the service: `service.ok`, `manager.inspect() === "active"`, else say to run `paddock local`.
5. Check the existing serve target: refuse if it is non-null and `!ownsServe`, and print it.
6. `writeTailscaleConfig`, with the login from `loginOverride ?? node.login`.
7. `manager.restart()`, then poll `127.0.0.1:<port>/api/health` until it answers, for up to 10s.
8. `serveOn`.
9. `fetchHealth("https://<host>/api/health")` must be `"paddock"` or `"gate"`. Both prove the ts.net name reaches the tailnet listener. Otherwise print what came back and return 1.
10. Print `✓ tailscale — https://<host>`, the QR when `wantsQr`, and the phone line: `open it on your phone, Share → Add to Home Screen, then enable push in Settings`.

`runTailscaleOff`: run `serveOff` only if `ownsServe(servedTarget)`; then `removeTailscaleConfig`; then `restart()` if the service is active; then print `✓ tailscale — off`.

- [ ] **Step 1: Write failing tests.** Use fakes for `Run`, the service manager, `fetchHealth` and `find`.
  - one test per refusal (1–5), each asserting exit 1, its message, and that no later step ran (no config written, no serve)
  - `refuses when 443 serves something else`: names the target and does not call `serveOn`
  - `happy path order`: config written with lowercased login, then restart, then `serveOn` with the tailnet port, then health, then output contains the URL
  - `--login overrides the owner`
  - `verify failure → exit 1 and names what came back`, with the config left in place so `off` can clean up
  - `second run is idempotent`: serve already ours → no refusal, same output
  - `off removes only our serve`: another target → `serveOff` not called, config still removed
  - cli: `parseArgs(["tailscale","off"]).args` deep-equals `["off"]`; `--login x` is captured
  - systemd and launchd `restart` argv
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement and wire dispatch in `index.ts`.
- [ ] **Step 4:** Run the tests and `make check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tailscale): paddock tailscale [off]`

### Task 6: `status`, `stop`, `local`

**Files:**
- Modify: `src/server/lifecycle/commands.ts` (`runStatus` adds `reportTailscale` after `reportTunnel`; `runStop` adds the serve removal)
- Modify: `src/server/lifecycle/local.ts` (after a successful install, re-apply serve when the config is enabled)
- Test: `tests/lifecycle-status.test.ts`, `tests/lifecycle-local.test.ts`, and the stop tests (next to the existing ones)

**Interfaces:**
- Consumes: Tasks 1, 2 and 4.
- Produces: `reportTailscale(o, log): Promise<void>`. It is silent when there is no config. Otherwise:
  - `✓ tailscale — https://<host>` / `    allows <login> · listener 127.0.0.1:<port>` when the listener answers (GET `/api/health` on the tailnet port without identity gives a 403 that `isTailnetRefusal` recognises) and serve targets it;
  - `✗ tailscale — enabled but the listener is not up (<why>)`, or `… but tailscale serve no longer points at it; run paddock tailscale` otherwise;
  - the `tailscale` binary missing → `?` line.
  The `status` exit code is unchanged.

- [ ] **Step 1: Write failing tests**
  - status: silent when no config; ✓ block; ✗ listener down; ✗ serve gone; exit code unchanged in each
  - stop: removes serve when ours, keeps it when not ours, keeps `tailscale.json` in both cases
  - local: config enabled → `serveOn` after install; no config → no tailscale calls; `serveOn` failure → warning, `local` still exits 0
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. `run` and `find` are injected through the existing opts objects.
- [ ] **Step 4:** Run the tests and `make check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tailscale): status line, stop and local keep serve in step`

### Task 7: docs and decision

**Files:**
- Modify: `docs/decisions.md`
  - new decision 35: Tailscale identity is an authenticating front on its own loopback listener, allowing one user
  - a per-listener allowlist, as an amendment to 17, with the reason
  - the bridge guarantee holds on the Cloudflare path only
  - `tailscale.json` is separate from settings, with the reason
  - Funnel never
- Modify: `docs/running-locally.md` (replace the one-line mention with the command, the prerequisites and the phone steps), `docs/settings.md` (a short "Not a setting: `tailscale.json`" note), `docs/deploy-cloudflare.md` (the MCP section gets the tailnet variant with the trust caveat), `README.md` (one line where remote access is introduced)
- Modify: `docs/architecture.md` if it lists listeners
- Modify: `docs/design/2026-10-26-tailscale-design.md` §Persistence. Add one paragraph saying the group became `tailscale.json`, and why (the refinement above).

- [ ] **Step 1:** Write the docs. `make check-clean`. Expected: `check-private: clean`.
- [ ] **Step 2:** `make test`. Expected: all pass. This includes `env-docs.test.ts`, which may require `PADDOCK_TAILNET_PORT` to be documented.
- [ ] **Step 3: Commit** `docs: Tailscale access, decision 35`

### Task 8: live verification (operator's machines, not CI)

Done by the session, not a subagent. This publishes on the tailnet only, never Funnel. If the harness refuses an action, stop and ask the operator.

- [ ] **Step 1:** `make build`, then install the binary as the service on the Linux box (memory: the service runs the compiled binary). Then run `paddock tailscale`. Expected: ✓ line and QR.
- [ ] **Step 2: Header forging.**
  - `curl -H 'Tailscale-User-Login: someone-else@github' https://<host>/api/health` from the node itself. Expected: 200 (serve overwrote the header with the real login), not 403 naming `someone-else`.
  - Repeat from a second device of the operator's.
  - If paddock ever sees a client-chosen login, revert the branch to before Task 3's wiring, and report to the operator before anything else.
- [ ] **Step 3: Host preservation.** A write from the phone succeeds (for example, the theme toggle saves), and `/ws` connects (the live dot is green). If either fails with `cross-origin`, serve rewrote Host. Fix it on the tailnet listener only (restore from `X-Forwarded-Host`), add a test, and re-verify.
- [ ] **Step 4: Phone end to end.** Add to Home Screen, enable push, trigger a blocked agent, and confirm the notification arrives and the tap opens the ts.net origin.
- [ ] **Step 5:** `paddock stop`, then `tailscale serve status` shows nothing of ours. `paddock local` brings back the same URL. `paddock tailscale off` clears everything.
- [ ] **Step 6:** Record the results (dates, what was observed, with no real names) in the design doc's verification section, and commit `docs: Tailscale live verification`.
