import { useLaunch } from "@web/launch";

/**
 * What became of the spawn the create sheet asked for, on the pane it was
 * asked for.
 *
 * Mounted by `PaneTerminal`, which both the shell view and — through
 * `AgentTerminal` — the agent view render, so neither branch of `App.tsx`
 * needs a copy of this. That matters for the failure case: a start that
 * failed leaves a shell, a start that succeeded leaves an agent, and paddock
 * must not need to know which one it is looking at to tell the operator what
 * happened.
 *
 * Renders NOTHING when there is no launch, or when the launch belongs to
 * another pane. A notice keyed on the pane is how navigating away drops it
 * instead of carrying "claude did not start" onto an unrelated screen.
 */
export function LaunchNotice({ paneId }: { paneId: string }) {
  const { launch, setLaunch } = useLaunch();
  if (launch === null || launch.paneId !== paneId) return null;

  if (launch.phase === "starting") {
    // `role="status"`, not `alert`: this is progress, and it is on screen for
    // the operator who just asked for it. `agent.start` blocks for up to 30 s
    // (§9.2), which is long enough that a bare shell with no explanation reads
    // as a create that did nothing.
    return (
      <p className="launch-notice" role="status" data-launch="starting">
        starting {launch.kind}…
      </p>
    );
  }

  return (
    // `role="alert"` so it is announced on insert — the pane's own screen is
    // already rendered by the time herdr refuses, so this arrives into a
    // settled page.
    <div className="launch-notice launch-failed" role="alert" data-launch="failed">
      {/* Said by paddock, in paddock's words, so the sentence is present
          whichever refusal shape arrived. The route's partial-failure detail
          says it too ("shell exists, but the agent did not start: …") but a
          400 from the kind allowlist does not, and the operator must not have
          to infer it from `unsupported kind: x`. */}
      <p className="launch-failed-head">{launch.kind} did not start.</p>
      {/* herdr's own words, verbatim and unabridged (§11). */}
      <p className="launch-detail">{launch.detail}</p>
      {/* Dismissed by the operator, never on a timer: an error with a
          three-second window is a swallowed error (`settings/Toast.tsx`). */}
      <button type="button" onClick={() => setLaunch(null)}>Dismiss</button>
    </div>
  );
}
