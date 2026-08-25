import { create } from "zustand";
import { startAgent } from "@web/api";
import type { StartAgentResult } from "@shared/types";

/**
 * The state of a spawn that OUTLIVES the sheet that asked for it.
 *
 * §9.2 splits create and spawn into two calls, and it navigates to the new
 * pane after the FIRST one — the shell exists and renders, so the operator
 * lands on the tab they just made instead of watching a spinner. That
 * navigation unmounts the Spaces screen and with it the create sheet, which
 * means the component that issued `agent.start` is gone before the call
 * answers. Anything the sheet held — a `busy` flag, an error string — is gone
 * with it.
 *
 * So the launch lives HERE, at module scope, and the pane's own screen renders
 * it (`LaunchNotice`, mounted by `PaneTerminal`). Two things depend on that
 * and neither is cosmetic:
 *
 * - `starting claude…` is visible while `agent.start` blocks, which it does
 *   for up to 30 s by default (§9.2). Without this the operator sits on a bare
 *   shell with nothing saying anything was asked for.
 * - A FAILED start is surfaced verbatim, on the pane it failed in. The route
 *   distinguishes a partial failure ("shell exists, but the agent did not
 *   start: …", with `paneId` echoed even on the 502), and the tab the operator
 *   did not have before must not be invisible to them: paddock navigates
 *   anyway and says the agent did not start. A toast would not do — see
 *   `settings/Toast.tsx`, which is success-only for exactly this reason: an
 *   error the operator has to catch inside a three-second window is a
 *   swallowed error.
 */
export interface Launch {
  /** The pane the agent was asked to start in. `LaunchNotice` renders only on
   *  THIS pane, so navigating away does not carry a stale banner along. */
  paneId: string;
  /** The harness kind, as chosen — for `starting <kind>…` and for naming what
   *  did not start. */
  kind: string;
  phase: "starting" | "failed";
  /** herdr's own words, verbatim, once it has refused. Null while starting. */
  detail: string | null;
}

interface LaunchStore {
  launch: Launch | null;
  setLaunch(next: Launch | null): void;
}

/** Its own store rather than a field on `store.ts`: that one is the websocket's
 *  view of the herd, and nothing here arrives over the socket. */
export const useLaunch = create<LaunchStore>((set) => ({
  launch: null,
  setLaunch: (next) => set({ launch: next }),
}));

/** Just the call the launch makes. Injected in tests for the same reason
 *  `RowSenders` is: no network, and a failure is a value rather than a throw
 *  that escapes an unmounted component. */
export type StartSender = (paneId: string, kind: string, name: string) => Promise<StartAgentResult>;

const LIVE_START: StartSender = (paneId, kind, name) => startAgent(paneId, kind, name);

/**
 * Start an agent, reporting through the store rather than to a caller.
 *
 * Returns a promise so a test can await it; the sheet deliberately does not,
 * because by the time this resolves the sheet is unmounted (see above).
 *
 * A 200 whose body says `ok: false` is treated as a FAILURE, not a success.
 * The route never sends one today — but "never a success that hides a failed
 * start" (§9.2) is the rule, and a client that reads only the status code is
 * one route change away from breaking it silently.
 */
export async function launchAgent(
  paneId: string, kind: string, name: string, send: StartSender = LIVE_START,
): Promise<void> {
  const { setLaunch } = useLaunch.getState();
  setLaunch({ paneId, kind, phase: "starting", detail: null });
  try {
    const res = await send(paneId, kind, name);
    if (res.ok === false) throw new Error(res.detail ?? "the agent did not start");
    // Cleared only if this launch is still the one being reported. A second
    // spawn started while the first was in flight owns the notice, and
    // clearing it here would erase the newer one's `starting…`.
    const current = useLaunch.getState().launch;
    if (current?.paneId === paneId && current.phase === "starting") {
      useLaunch.getState().setLaunch(null);
    }
  } catch (err) {
    useLaunch.getState().setLaunch({
      paneId, kind, phase: "failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
