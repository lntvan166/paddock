import { ProtocolMismatchError, request } from "@server/herdr/socket";
import {
  herdrUnreachableMessage,
  inspectSocketPath,
  isDiagnosableHerdrFailure,
} from "@server/startup-errors";
import { HERDR_PROTOCOL } from "@shared/herdr-api";

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

export function doctorReport(expected: number, probe: DoctorProbe): DoctorReport {
  if (probe.kind === "unreachable") return { code: 2, text: probe.message };
  if (probe.protocol !== expected) {
    // Deliberately the server's own message rather than a second wording of it.
    // Two texts for one condition drift, and this is the text an operator will
    // see again seconds later if they start paddock anyway.
    return { code: 1, text: new ProtocolMismatchError(expected, probe.protocol).message };
  }
  const lines = [
    "paddock: herdr looks compatible",
    `  paddock expects  ${expected}`,
    `  herdr reports    ${probe.protocol}`,
  ];
  if (probe.version) lines.push(`  herdr version    ${probe.version}`);
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
  const print = opts.print ?? ((line) => console.log(line));

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

  const report = doctorReport(expected, probe);
  print(report.text);
  return report.code;
}
