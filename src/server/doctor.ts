import {
  herdrUnreachableMessage,
  inspectSocketPath,
  isDiagnosableHerdrFailure,
} from "@server/startup-errors";
import { findCloudflared } from "@server/tunnel/cloudflared";
import { ProtocolMismatchError, request } from "@server/herdr/socket";
import { HERDR_PROTOCOL } from "@shared/herdr-api";
import { say } from "@server/term";

/** What was learned about herdr, or that nothing was. */
export type DoctorProbe =
  | { kind: "answered"; protocol: number; version?: string }
  | { kind: "unreachable"; message: string };

export interface DoctorReport {
  /**
   * 0 compatible, 1 incompatible, 2 undetermined.
   *
   * install.sh reads this, which is why 1 and 2 are not one "non-zero": herdr
   * not installed yet, or simply not running, is a legitimate state during an
   * install and must not be reported as a problem with the install.
   */
  code: 0 | 1 | 2;
  text: string;
}

export function doctorReport(
  expected: number,
  probe: DoctorProbe,
  extra: { cloudflared: string | null } = { cloudflared: null },
): DoctorReport {
  if (probe.kind === "unreachable") return { code: 2, text: probe.message };
  // DIRECTIONAL, matching `checkProtocol`. Only an OLDER herdr is incompatible:
  // it genuinely lacks what this paddock reads. A newer one is reported below
  // and scored 0, because `install.sh` reads this code and herdr moving ahead
  // (0.8.0 → 0.8.2 bumped 19 → 20 and changed nothing paddock reads) is not a
  // broken install. If these two ever disagree about a direction, this file is
  // the one that lies to install.sh.
  // Guarded before the comparison, and the stakes here are higher than in
  // `checkProtocol`: `install.sh` reads this code, so a non-numeric protocol
  // falling through to 0 would print nothing at all while the text said
  // "herdr reports undefined" — the code and the text disagreeing, which is
  // exactly what this file must never do.
  if (typeof probe.protocol !== "number" || !Number.isFinite(probe.protocol)) {
    return { code: 1, text: new ProtocolMismatchError(expected, probe.protocol).message };
  }

  if (probe.protocol < expected) {
    // Deliberately the server's own message rather than a second wording of it.
    // Two texts for one condition drift, and this is the text an operator will
    // see again seconds later if they start paddock anyway. Nothing about
    // cloudflared is appended here either: this branch is herdr's own message
    // about the one problem worth reporting, and an unrelated line about an
    // optional binary would bury the finding an operator actually needs.
    return { code: 1, text: new ProtocolMismatchError(expected, probe.protocol).message };
  }
  const lines = [
    "paddock: herdr looks compatible",
    `  paddock expects  ${expected}`,
    `  herdr reports    ${probe.protocol}`,
  ];
  if (probe.version) lines.push(`  herdr version    ${probe.version}`);
  // Reported, never scored. cloudflared is optional — `paddock tunnel` needs
  // it and nothing else does, so its absence must not turn a healthy herdr
  // into a non-zero exit that install.sh would read as a broken install. A
  // future edit that "tidies" this into the exit code would break install.sh
  // silently, since 0 is the only code it treats as success.
  lines.push(
    extra.cloudflared === null
      ? "  cloudflared      not installed (only `paddock tunnel` needs it)"
      : `  cloudflared      ${extra.cloudflared}`,
  );

  if (probe.protocol > expected) {
    // Compatible, but say which side is ahead — it is the only part that tells
    // an operator whether there is anything for them to do.
    lines.push(
      "",
      "  herdr is newer than this paddock, which is accepted: paddock checks",
      "  the fields it reads against live agent.list data rather than trusting",
      "  the protocol number. `paddock update` picks up support for anything",
      "  the newer protocol added.",
    );
  }
  return { code: 0, text: lines.join("\n") };
}

/**
 * Ping herdr and say whether this paddock can talk to it.
 *
 * The ping goes over the socket, NOT to `herdr api schema`: the socket answers
 * from the running daemon and the CLI answers from the binary on disk, and those
 * disagree after an upgrade until the daemon restarts — which is the exact
 * confusion this command exists to settle.
 *
 * `ping` and `print` are injectable so the exit-code contract can be tested
 * without a live herdr.
 */
export async function runDoctor(opts: {
  socketPath: string;
  expected?: number;
  ping?: (path: string) => Promise<{ protocol: number; version?: string }>;
  print?: (line: string) => void;
}): Promise<number> {
  const expected = opts.expected ?? HERDR_PROTOCOL;
  const ping =
    opts.ping ?? ((path) => request<{ protocol: number; version?: string }>(path, "ping", {}));
  const print = opts.print ?? say;

  let probe: DoctorProbe;
  try {
    const pong = await ping(opts.socketPath);
    probe = { kind: "answered", protocol: pong.protocol, version: pong.version };
  } catch (err) {
    const kind = inspectSocketPath(opts.socketPath);
    probe = {
      kind: "unreachable",
      message: isDiagnosableHerdrFailure(err, kind)
        ? herdrUnreachableMessage(opts.socketPath, err, kind)
        : `paddock: could not ask herdr for its protocol: ${err}`,
    };
  }

  const report = doctorReport(expected, probe, { cloudflared: findCloudflared() });
  print(report.text);
  return report.code;
}
