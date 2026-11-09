import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { parsePrompt } from "@server/herdr/prompt-parse";

/**
 * The answer path through herdr-core, asserted against a real blocked agent.
 *
 * WHY THIS FILE EXISTS. Answering a blocked permission prompt is paddock's
 * reason to exist, and herdr-core guards a blocked program on purpose:
 * `terminal.send` refuses one unless `force`. The herdr-core backend was gated
 * on finding a supported way through (docs/probes/2026-11-09-herdr-core.md).
 * The measured answer: `terminal.keys` with the option's digit, one key per
 * call. This file is that measurement, executed rather than remembered, so the
 * day herdr-core starts holding keys for a blocked program — or Claude Code
 * changes its dialog — it names the fact that broke instead of a phone
 * finding out.
 *
 * It also pins the trap the probe found: `terminal.send {text, force:true}`
 * does NOT pick the option whose digit it pastes. The paste is not a key
 * press, and the Enter after it commits whatever row the cursor is on — the
 * first row, "Yes", on a fresh dialog. That is the mislabelled Approve button
 * CLAUDE.md bans, so paddock must never answer a dialog with a forced send.
 * This file does not re-run that case: it would approve the probe's command.
 *
 * SAFETY. These tests SEND KEYS, so they run only against a terminal named
 * explicitly by `HC_PROBE_TERMINAL`, and only with `PADDOCK_CORE_PROBE=1`, and
 * skip loudly otherwise. They answer "No", which is harmless. To set one up:
 *
 *     cd "$(mktemp -d)"
 *     hc run --bg --keep --name probe-blocked \
 *       --label herdr.space=probe --label herdr.tab=probe -- claude
 *     # switch Claude Code to manual mode (shift+tab) if it starts in auto
 *     PADDOCK_CORE_PROBE=1 HC_PROBE_TERMINAL=probe-blocked \
 *       bun test tests/core-live.test.ts
 *
 * and `hc kill probe-blocked` when done: the probe space closes with its last
 * terminal. Each test asks the probe to `touch` a file in its own scratch
 * folder, waits for the permission prompt, and answers it. The probe is a real
 * Claude Code session and costs real usage, which is why this is a deliberate
 * act rather than part of `make test`.
 *
 * ORDER MATTERS. The first two tests leave the probe blocked on purpose (one
 * only parses the prompt, the other is refused and types nothing), and the
 * next test relies on `block()` returning early on that same prompt instead
 * of asking for a new one. Run the file whole and in order. Do not use
 * `--test-name-pattern` to run one answering test alone, or shuffle the order.
 */

const PROBE = process.env.HC_PROBE_TERMINAL ?? "";
const ENABLED = process.env.PADDOCK_CORE_PROBE === "1";

/** herdr-core's documented order: HC_SOCKET, then the runtime dir, then /run/user. */
function coreSocket(): string {
  if (process.env.HC_SOCKET) return process.env.HC_SOCKET;
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
  return join(runtime, "herdr-core", "default.sock");
}
const SOCKET = coreSocket();

function socketPresent(): boolean {
  try {
    return statSync(SOCKET).isSocket();
  } catch {
    return false;
  }
}

type RpcReply = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: { kind?: string; hint?: string } };
};

/** One JSON-RPC request on its own plain connection: one line out, one line back. */
function rpc(method: string, params: Record<string, unknown>): Promise<RpcReply> {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      sock.end();
      resolve(JSON.parse(buf.slice(0, nl)) as RpcReply);
    });
    sock.on("error", reject);
    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
}

type Status = { state?: string; kind?: string };

async function status(): Promise<Status> {
  const reply = await rpc("terminal.get", { terminal: PROBE });
  if (reply.error) throw new Error(`terminal.get ${PROBE}: ${reply.error.message}`);
  return (reply.result?.status as Status | undefined) ?? {};
}

async function screen(): Promise<string> {
  const reply = await rpc("terminal.read", { terminal: PROBE });
  if (reply.error) throw new Error(`terminal.read ${PROBE}: ${reply.error.message}`);
  return String(reply.result?.text ?? "");
}

/**
 * How many times the screen and its history say a tool call was interrupted.
 * This is a secondary signal: the status leaving `blocked` is the real check.
 * The "Interrupted" substring belongs to Claude Code's wording, so a change to
 * that wording breaks this signal, not the answer path.
 */
async function interrupted(): Promise<number> {
  const reply = await rpc("terminal.read", { terminal: PROBE, lines: 5000 });
  if (reply.error) throw new Error(`terminal.read ${PROBE}: ${reply.error.message}`);
  return String(reply.result?.text ?? "").split("Interrupted").length - 1;
}

/** Poll until the status leaves `from`, or give up. Polling, not a fixed sleep. */
async function leaves(from: string, ms = 10_000): Promise<Status> {
  const until = Date.now() + ms;
  let s = await status();
  while (s.state === from && Date.now() < until) {
    await Bun.sleep(100);
    s = await status();
  }
  return s;
}

/** Bring the probe to a fresh permission prompt, whatever it was doing. */
async function block(): Promise<void> {
  let s = await status();
  if (s.state === "blocked") return;
  const sent = await rpc("terminal.send", {
    terminal: PROBE,
    text: "Run exactly this shell command with the Bash tool and nothing else: touch core-live-probe.txt",
  });
  if (sent.error) throw new Error(`terminal.send: ${sent.error.message}`);
  const waited = await rpc("terminal.wait", { terminal: PROBE, timeout: 120 });
  if (waited.error) throw new Error(`terminal.wait: ${waited.error.message}`);
  s = await status();
  if (s.state !== "blocked" || s.kind !== "permission") {
    throw new Error(`probe did not block on a permission prompt: ${JSON.stringify(s)}`);
  }
}

/** The key of the option whose label is exactly "No" — read off the screen, never assumed. */
function noKey(text: string): string {
  const parsed = parsePrompt(text);
  const no = (parsed.options ?? []).find((o) => o.label.trim() === "No");
  if (!no) throw new Error(`no "No" option on the prompt: ${JSON.stringify(parsed.options)}`);
  return no.key;
}

const ready = ENABLED && PROBE !== "" && socketPresent() && (await status().catch(() => null)) !== null;
if (!ready) {
  console.warn(
    !ENABLED || PROBE === ""
      ? "SKIPPED tests/core-live.test.ts: set PADDOCK_CORE_PROBE=1 and HC_PROBE_TERMINAL to a probe terminal (see the file header)"
      : !socketPresent()
        ? `SKIPPED tests/core-live.test.ts: no herdr-core socket at ${SOCKET}`
        : `SKIPPED tests/core-live.test.ts: no terminal ${PROBE} on the core`,
  );
}

const LONG = 180_000;

test.skipIf(!ready)(
  "the prompt parses as a digit-commit dialog with a real No option",
  async () => {
    await block();
    const parsed = parsePrompt(await screen());
    expect(parsed.commit).toBe("digit");
    expect((parsed.options ?? []).length).toBeGreaterThanOrEqual(2);
    expect((parsed.options ?? []).some((o) => o.label.trim() === "No")).toBe(true);
  },
  LONG,
);

test.skipIf(!ready)(
  "a plain send is refused while blocked, with data.kind blocked, and types nothing",
  async () => {
    await block();
    const before = await screen();
    const reply = await rpc("terminal.send", { terminal: PROBE, text: noKey(before) });
    expect(reply.error?.data?.kind).toBe("blocked");
    expect((await status()).state).toBe("blocked");
  },
  LONG,
);

test.skipIf(!ready)(
  "terminal.keys with the option's digit answers the prompt (the answer path)",
  async () => {
    await block();
    const seen = await interrupted();
    const key = noKey(await screen());
    const reply = await rpc("terminal.keys", { terminal: PROBE, keys: [key] });
    expect(reply.error).toBeUndefined();
    const after = await leaves("blocked");
    expect(after.state).not.toBe("blocked");
    // "No" interrupts the tool call; Claude Code says so on screen.
    expect(await interrupted()).toBeGreaterThan(seen);
  },
  LONG,
);

test.skipIf(!ready)(
  "on a USED dialog (cursor already moved) the digit still picks its own row",
  async () => {
    await block();
    const seen = await interrupted();
    const key = noKey(await screen());
    // One key per call, settled, as CLAUDE.md requires for TUI probes.
    expect((await rpc("terminal.keys", { terminal: PROBE, keys: ["down"] })).error).toBeUndefined();
    await Bun.sleep(300);
    expect((parsePrompt(await screen()).options ?? []).find((o) => o.selected)?.key).toBe("2");
    expect((await rpc("terminal.keys", { terminal: PROBE, keys: [key] })).error).toBeUndefined();
    expect((await leaves("blocked")).state).not.toBe("blocked");
    expect(await interrupted()).toBeGreaterThan(seen);
  },
  LONG,
);

test.skipIf(!ready)(
  "arrows then enter on the cursor row answers too",
  async () => {
    await block();
    const seen = await interrupted();
    const parsed = parsePrompt(await screen());
    const target = (parsed.options ?? []).findIndex((o) => o.label.trim() === "No");
    const from = Math.max(0, (parsed.options ?? []).findIndex((o) => o.selected));
    expect(target).toBeGreaterThanOrEqual(0);
    for (let i = from; i < target; i++) {
      expect((await rpc("terminal.keys", { terminal: PROBE, keys: ["down"] })).error).toBeUndefined();
      await Bun.sleep(300);
    }
    expect((parsePrompt(await screen()).options ?? []).find((o) => o.selected)?.label.trim()).toBe("No");
    expect((await rpc("terminal.keys", { terminal: PROBE, keys: ["enter"] })).error).toBeUndefined();
    expect((await leaves("blocked")).state).not.toBe("blocked");
    expect(await interrupted()).toBeGreaterThan(seen);
  },
  LONG,
);
