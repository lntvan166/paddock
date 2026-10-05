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
