/**
 * The first thing an operator sees, and the reason it needed rearranging.
 *
 * Measured, on a fresh machine:
 *
 *   herdr: agent.list carries every field paddock reads
 *   herdr event stream connected
 *   herdr: subscribed {
 *     panes: 1,
 *   }
 *   paddock listening on http://127.0.0.1:8787
 *
 * Four lines of internal bookkeeping, and then the one fact the operator came
 * for — the URL — arriving last, below the fold of their attention. Every one
 * of those four lines is TRUE and worth logging; none of them is what a person
 * starting a dashboard is looking for.
 *
 * The URL cannot simply be printed first: the port is not bound until later,
 * and a URL printed before the listener exists is a lie every time the bind
 * hits EADDRINUSE. So the diagnostics move instead of the URL — collected
 * during boot, emitted as ONE line above the banner.
 *
 * Nothing is dropped. CLAUDE.md's no-swallowing rule leans on precisely these
 * lines ("Event receipt logs at INFO … so a silent break is visible within
 * seconds"), so every fact still reaches stdout, and after `end()` each call
 * site logs individually exactly as it did before. Boot is a report; steady
 * state is a trace. This class is only the difference between the two.
 */
export type ShapeKind = "ok" | "unknown" | "broken";

export class BootLog {
  private booting = true;
  private streamUp: boolean | null = null;
  private panes: number | null = null;
  private shape: ShapeKind | null = null;

  /** False once `end()` has run, which is what makes the call sites verbose. */
  get inBoot(): boolean {
    return this.booting;
  }

  noteStream(up: boolean): void {
    this.streamUp = up;
  }

  notePanes(n: number): void {
    this.panes = n;
  }

  noteShape(kind: ShapeKind): void {
    this.shape = kind;
  }

  /**
   * One line, or null when there is nothing to report — demo mode never touches
   * herdr, and a line reading `herdr:` there would describe a connection that
   * was never attempted.
   *
   * A `broken` shape is NOT summarised. It is the one verdict that must not be
   * compressed into a clause at the end of a status line: it means paddock is
   * reading fields herdr no longer sends, and it is printed in full by
   * `shapeMessage` on its own path. Summarising it here would put the project's
   * loudest failure in its quietest typography.
   */
  summary(): string | null {
    if (this.streamUp === null && this.panes === null && this.shape === null) return null;

    const parts: string[] = [];
    parts.push(this.streamUp === true ? "connected" : this.streamUp === false ? "not connected" : "no stream");
    if (this.panes !== null) parts.push(this.panes === 1 ? "1 pane" : `${this.panes} panes`);
    if (this.shape === "ok") parts.push("every field paddock reads is present");
    else if (this.shape === "unknown") parts.push("no panes to inspect, contract unverified");

    return `herdr: ${parts.join(" · ")}`;
  }

  /** Boot is over: from here the call sites log every event as they always did. */
  end(): void {
    this.booting = false;
  }
}
