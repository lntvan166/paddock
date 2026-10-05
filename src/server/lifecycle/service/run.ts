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
