import { ProtocolMismatchError } from "@server/herdr/socket";

/** Exponential backoff with full jitter, capped at 15s (spec §7). */
export function backoffWithJitter(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(15_000, 500 * 2 ** attempt);
  return Math.round(random() * ceiling);
}

export interface StreamKeeperOptions {
  /** Supervisor.refresh — reconcile, then re-subscribe naming the live panes. */
  refresh: () => Promise<void>;
  backoff?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called for an error that retrying can never fix. */
  onFatal?: (err: Error) => void;
}

export class StreamKeeper {
  private running = false;
  private stopped = false;
  private tries = 0;
  private loop: Promise<void> = Promise.resolve();

  constructor(private readonly opts: StreamKeeperOptions) {}

  get reconnecting(): boolean { return this.running; }
  get attempts(): number { return this.tries; }

  /** Await the current retry loop. Exposed for tests and shutdown. */
  settled(): Promise<void> { return this.loop; }

  stop(): void { this.stopped = true; }

  /**
   * The stream dropped. Idempotent: repeated calls while a retry loop is
   * already running are ignored, so a flapping socket cannot spawn a loop per
   * drop and hammer herdr.
   */
  notifyClosed(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.loop = this.run().finally(() => { this.running = false; });
  }

  private async run(): Promise<void> {
    const backoff = this.opts.backoff ?? backoffWithJitter;
    const sleep = this.opts.sleep ?? ((ms: number) => Bun.sleep(ms));

    for (let attempt = 0; !this.stopped; attempt++) {
      this.tries++;
      try {
        await this.opts.refresh();
        console.info("herdr: event stream recovered", { attempts: this.tries });
        return;
      } catch (err) {
        // A version mismatch cannot be retried into success. Surface it.
        if (err instanceof ProtocolMismatchError) {
          console.error(err.message);
          this.opts.onFatal?.(err);
          return;
        }
        console.error("herdr: reconnect attempt failed", { attempt, err });
        await sleep(backoff(attempt));
      }
    }
  }
}
