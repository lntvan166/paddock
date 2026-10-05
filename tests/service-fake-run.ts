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
