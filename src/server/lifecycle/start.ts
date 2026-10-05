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
