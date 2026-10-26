import { existsSync } from "node:fs";
import { defaultHealthCheck } from "@server/lifecycle/commands";
import type { ServiceChoice } from "@server/lifecycle/service";
import { spawnRun } from "@server/lifecycle/service/run";
import type { Run, ServiceManager } from "@server/lifecycle/service/types";
import { qrMatrix } from "@server/qr";
import {
  findTailscale, ownsServe, readNode, serveOff, serveOn, servedTarget,
} from "@server/tailscale/cli";
import { removeTailscaleConfig, writeTailscaleConfig } from "@server/tailscale/config";
import { isTailnetRefusal } from "@server/tailscale/gate";
import { glyph, say } from "@server/term";
import { qrLines } from "@server/tunnel/display";
import { wantsQr } from "@server/tunnel/run";

export interface TailscaleOpts {
  dir: string;
  /** The default listener, polled after the restart. */
  port: number;
  /** The tailnet listener `tailscale serve` forwards to. */
  tailnetPort: number;
  /** `--login`: the Tailscale user to allow instead of the machine's owner. */
  loginOverride?: string;
  service: ServiceChoice | undefined;
  run?: Run;
  find?: () => string | null;
  inContainer?: () => boolean;
  /** `"paddock"`, `"gate"`, or a description of what came back instead. */
  fetchHealth?: (url: string) => Promise<"paddock" | "gate" | string>;
  /** Whether 127.0.0.1:<port>/api/health answers. Injected for tests. */
  localHealth?: (port: number) => Promise<boolean>;
  /** How long to wait for the restarted service to answer. */
  waitMs?: number;
  log?: (line: string) => void;
  colour?: boolean;
  columns?: number;
  rows?: number;
}

const PHONE = "open it on your phone, Share → Add to Home Screen, then enable push in Settings";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function defaultInContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

/**
 * GET a health URL through the tailnet name. A 200 with paddock's health JSON
 * and the tailnet gate's 403 both prove the ts.net name reaches the tailnet
 * listener: the CLI's own request may carry no identity, and the gate is
 * paddock's. Anything else is described, never guessed at.
 *
 * Bounded: an unreachable ts.net name must not hang the CLI.
 */
export async function fetchHealth(
  url: string,
  f: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<"paddock" | "gate" | string> {
  let res: Response;
  try {
    res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return `no answer from ${url} (${message(e)})`;
  }
  const text = await res.text().catch((e) => `<unreadable body: ${message(e)}>`);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON is an answer in itself; it is described below, with the body.
  }
  if (
    res.status === 200 && typeof body === "object" && body !== null &&
    (body as { ok?: unknown }).ok === true && "hostId" in body
  ) return "paddock";
  if (res.status === 403 && isTailnetRefusal(body)) return "gate";
  const snippet = text.trim().replace(/\s+/g, " ").slice(0, 120);
  return `HTTP ${res.status}${snippet === "" ? "" : `: ${snippet}`}`;
}

/** The running service, or the reason there is none. */
async function activeService(
  service: ServiceChoice | undefined,
): Promise<{ ok: true; manager: ServiceManager } | { ok: false; reason: string }> {
  if (service === undefined) return { ok: false, reason: "no service manager here" };
  if (!service.ok) return { ok: false, reason: service.reason };
  const status = await service.manager.inspect();
  if (status !== "active") return { ok: false, reason: `the ${service.manager.kind} service is ${status}` };
  return { ok: true, manager: service.manager };
}

/**
 * `paddock tailscale` — publish the running service on this machine's tailnet
 * HTTPS name, for its owner (or `--login`) only. Every refusal says what is
 * wrong and the fix, and happens before anything is written or served.
 */
export async function runTailscale(o: TailscaleOpts): Promise<number> {
  const log = o.log ?? say;
  const run = o.run ?? spawnRun;
  const fail = (...lines: string[]) => {
    for (const l of lines) log(l);
    return 1;
  };

  // 1. Docker's loopback is not the host's, and the listener must never leave it.
  if ((o.inContainer ?? defaultInContainer)()) {
    return fail(
      `${glyph("no")} tailscale — not supported inside a container`,
      "    `tailscale serve` on the host cannot reach a loopback listener in here; run paddock on the host",
    );
  }

  // 2.
  const bin = (o.find ?? (() => findTailscale()))();
  if (bin === null) {
    return fail(
      `${glyph("no")} tailscale — the \`tailscale\` CLI was not found`,
      "    install Tailscale and sign in: https://tailscale.com/download",
    );
  }

  // 3.
  const got = await readNode(run, bin);
  if (!got.ok) {
    return fail(
      `${glyph("no")} tailscale — could not read this node's status: ${got.error}`,
      "    is tailscaled running? `tailscale status` shows what it says",
    );
  }
  const node = got.node;
  if (!node.running) {
    return fail(
      `${glyph("no")} tailscale — this node is not logged in and running`,
      "    run `tailscale up`, then try again",
    );
  }
  if (!node.certs) {
    return fail(
      `${glyph("no")} tailscale — HTTPS certificates are not enabled for this tailnet`,
      "    enable them in the admin console → DNS → HTTPS Certificates, then try again",
    );
  }
  if (node.host === "") {
    return fail(
      `${glyph("no")} tailscale — this node has no tailnet DNS name`,
      "    check MagicDNS in the admin console → DNS, then try again",
    );
  }
  const login = (o.loginOverride ?? node.login).trim().toLowerCase();
  if (login === "") {
    return fail(
      `${glyph("no")} tailscale — this node has no Tailscale user (a tagged device?)`,
      "    say who may use it: paddock tailscale --login <name>",
    );
  }

  // 4.
  const svc = await activeService(o.service);
  if (!svc.ok) {
    return fail(
      `${glyph("no")} tailscale — paddock is not running as a service (${svc.reason})`,
      "    run `paddock local` first, then `paddock tailscale`",
    );
  }

  // 5. "Could not ask" is a refusal, never "free".
  let target: string | null;
  try {
    target = await servedTarget(run, bin);
  } catch (e) {
    return fail(`${glyph("no")} tailscale — could not read the serve config: ${message(e)}`);
  }
  if (target !== null && !ownsServe(target, o.tailnetPort)) {
    return fail(
      `${glyph("no")} tailscale — HTTPS 443 on this node already serves ${target}`,
      "    not overwriting it; `tailscale serve status` shows it, and",
      "    `tailscale serve --https=443 off` frees it if you no longer need it",
    );
  }

  // 6. The service reads this file at startup only, hence the restart.
  await writeTailscaleConfig(o.dir, { enabled: true, login, host: node.host });

  // 7.
  try {
    await svc.manager.restart();
  } catch (e) {
    return fail(`${glyph("no")} tailscale — could not restart the service: ${message(e)}`);
  }
  const health = o.localHealth ?? defaultHealthCheck;
  const deadline = Date.now() + (o.waitMs ?? 10_000);
  let up = await health(o.port);
  while (!up && Date.now() < deadline) {
    await Bun.sleep(200);
    up = await health(o.port);
  }
  if (!up) {
    return fail(
      `${glyph("no")} tailscale — the restarted service is not answering on port ${o.port}`,
      `    its output: ${svc.manager.logHint}`,
    );
  }

  // 8.
  try {
    await serveOn(run, bin, o.tailnetPort);
  } catch (e) {
    return fail(`${glyph("no")} tailscale — ${message(e)}`);
  }

  // 9.
  const url = `https://${node.host}`;
  const verdict = await (o.fetchHealth ?? ((u: string) => fetchHealth(u)))(`${url}/api/health`);
  if (verdict !== "paddock" && verdict !== "gate") {
    return fail(
      `${glyph("no")} tailscale — ${url} did not reach paddock's tailnet listener`,
      `    got: ${verdict}`,
      `    the service's output: ${svc.manager.logHint}`,
      "    `paddock tailscale off` undoes this",
    );
  }

  // 10.
  log(`${glyph("yes")} tailscale — ${url}`);
  log(`    allows ${login} · listener 127.0.0.1:${o.tailnetPort}`);
  const colour = o.colour ?? false;
  if (wantsQr({ colour, columns: o.columns ?? 0, rows: o.rows ?? 0 })) {
    log("");
    for (const line of qrLines(qrMatrix(url), colour)) log(line);
    log("");
  }
  log(`    ${PHONE}`);
  return 0;
}

/**
 * `paddock tailscale off` — undo it. Removes the 443 serve only when it is
 * paddock's own, and clears the config even when Tailscale cannot be asked:
 * the config is what decides whether the listener comes back.
 */
export async function runTailscaleOff(o: TailscaleOpts): Promise<number> {
  const log = o.log ?? say;
  const run = o.run ?? spawnRun;
  let code = 0;

  const bin = (o.find ?? (() => findTailscale()))();
  if (bin === null) {
    log(`${glyph("no")} the \`tailscale\` CLI was not found, so its serve config was not checked`);
    code = 1;
  } else {
    try {
      const target = await servedTarget(run, bin);
      if (ownsServe(target, o.tailnetPort)) {
        await serveOff(run, bin);
      } else if (target !== null) {
        log(`    HTTPS 443 serves ${target}, not paddock — left alone`);
      }
    } catch (e) {
      log(`${glyph("no")} could not remove tailscale's serve config: ${message(e)}`);
      log("    `tailscale serve status` shows it; `tailscale serve --https=443 off` removes it");
      code = 1;
    }
  }

  await removeTailscaleConfig(o.dir);

  if (o.service?.ok && (await o.service.manager.inspect()) === "active") {
    try {
      await o.service.manager.restart();
    } catch (e) {
      log(`${glyph("no")} could not restart the service, so the tailnet listener is still up: ${message(e)}`);
      code = 1;
    }
  }

  log(code === 0
    ? `${glyph("yes")} tailscale — off`
    : `${glyph("unknown")} tailscale — config removed, with the problems above`);
  return code;
}
