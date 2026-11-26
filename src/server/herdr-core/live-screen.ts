import type { Terminal } from "@xterm/headless";
import type { CoreTerminal } from "@shared/herdr-core-api";
import { linesOf, mirrorTerminal } from "./screen";
import type { CoreClient } from "./socket";

/**
 * Live mirrors of the app terminals someone is looking at.
 *
 * The dashboard polls an open terminal (every second by default, backing off
 * to ten when nothing moves), and herdr-core's `terminal.read` has no colour.
 * Re-attaching on every poll to get the coloured first paint would cost the
 * core a connection and a repaint per poll. Instead, the first read attaches
 * as an OBSERVER (never types, never resizes: the core sizes a terminal by
 * its real viewers only), replays the first paint into a headless terminal,
 * and keeps the stream: every later read is answered from that mirror, which
 * the stream keeps current. A mirror nobody has read for `idleMs` is closed.
 *
 * A size change after the first paint retires the mirror rather than
 * resizing it: the core follows a RESIZE with a replacement paint, which
 * would land on top of history already in the mirror. The next read attaches
 * again, at the new size, with history.
 */

export type Observer = Pick<CoreClient, "request" | "observe">;

export interface LiveScreensOptions {
  /** Scrollback lines the first paint carries, and the mirror keeps. */
  history: number;
  idleMs?: number;
  /** The first paint has no end marker: it is done after this long with nothing new. */
  quietMs?: number;
  /** ...or this long after it started, on a terminal that never stops printing. */
  maxPaintMs?: number;
  /** No paint at all within this long is a failure. */
  timeoutMs?: number;
  maxViews?: number;
}

interface View {
  terminal: string;
  term: Terminal | null;
  close: () => void;
  /** Settles when the first paint has landed. */
  ready: Promise<void>;
  /** Resolves once every byte received so far is in the mirror. */
  written: Promise<void>;
  lastRead: number;
  idle: ReturnType<typeof setTimeout> | null;
  dead: boolean;
}

export class LiveScreens {
  private views = new Map<string, View>();
  /** Per terminal, who wants to hear that its screen moved. Kept apart from
   *  `views`: a mirror is retired and re-opened (idle, resize, a dropped
   *  stream) while the people watching it stay the same. */
  private watchers = new Map<string, Set<() => void>>();
  private readonly idleMs: number;
  private readonly quietMs: number;
  private readonly maxPaintMs: number;
  private readonly timeoutMs: number;
  private readonly maxViews: number;

  constructor(private readonly o: LiveScreensOptions) {
    this.idleMs = o.idleMs ?? 30_000;
    this.quietMs = o.quietMs ?? 40;
    this.maxPaintMs = o.maxPaintMs ?? 400;
    this.timeoutMs = o.timeoutMs ?? 5_000;
    this.maxViews = o.maxViews ?? 8;
  }

  /** `terminal` is the core's own address (`t7`), not paddock's `hc.` id. */
  async read(client: Observer, terminal: string, scrollback: boolean): Promise<string[]> {
    let view = this.views.get(terminal);
    if (!view || view.dead) view = this.open(client, terminal);
    this.touch(view);
    await view.ready;
    await view.written;
    if (view.dead || !view.term) throw new Error(`herdr-core: the view of ${terminal} ended before it could be read`);
    return linesOf(view.term, scrollback ? "all" : "screen");
  }

  /**
   * Be told whenever `terminal`'s screen may have moved: after new bytes are
   * in the mirror, and when the mirror is retired (so the watcher reads again,
   * which attaches again). It does not open a mirror by itself; the first
   * `read` does. Returns the unwatch.
   *
   * This is what lets the dashboard be pushed a screen instead of polling
   * for one: the observer stream already delivers every byte the program
   * prints, so the mirror knows the moment something changed.
   */
  watch(terminal: string, onChange: () => void): () => void {
    let set = this.watchers.get(terminal);
    if (!set) { set = new Set(); this.watchers.set(terminal, set); }
    set.add(onChange);
    return () => {
      const s = this.watchers.get(terminal);
      if (!s) return;
      s.delete(onChange);
      if (s.size === 0) this.watchers.delete(terminal);
    };
  }

  private changed(terminal: string): void {
    const set = this.watchers.get(terminal);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(); } catch (e) {
        console.info(`herdr-core: a screen watcher of ${terminal} failed (${(e as Error).message})`);
      }
    }
  }

  closeAll(): void {
    // Shutting down: nobody is to be told to read again.
    this.watchers.clear();
    for (const v of [...this.views.values()]) this.retire(v);
  }

  private touch(view: View): void {
    view.lastRead = Date.now();
    if (view.idle) clearTimeout(view.idle);
    // A watched mirror is not idle: its screen is being pushed, and a quiet
    // screen sends nothing to read. Retiring it would only re-attach.
    view.idle = setTimeout(() => (this.watchers.has(view.terminal) ? this.touch(view) : this.retire(view)), this.idleMs);
  }

  private retire(view: View): void {
    if (view.dead) return;
    view.dead = true;
    if (view.idle) clearTimeout(view.idle);
    if (this.views.get(view.terminal) === view) this.views.delete(view.terminal);
    view.close();
    view.term?.dispose();
    view.term = null;
    // A watched terminal is read again, which opens a fresh mirror.
    this.changed(view.terminal);
  }

  private open(client: Observer, terminal: string): View {
    // Room first: the least recently read mirror goes.
    while (this.views.size >= this.maxViews) {
      const oldest = [...this.views.values()].sort((a, b) => a.lastRead - b.lastRead)[0]!;
      this.retire(oldest);
    }

    const view: View = {
      terminal, term: null, close: () => {}, ready: Promise.resolve(), written: Promise.resolve(),
      lastRead: Date.now(), idle: null, dead: false,
    };
    this.views.set(terminal, view);

    let painted = false;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let cap: ReturnType<typeof setTimeout> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let settle!: (e?: Error) => void;
    view.ready = new Promise<void>((resolve, reject) => {
      settle = (e?: Error) => {
        if (painted) return;
        painted = true;
        if (quiet) clearTimeout(quiet);
        if (cap) clearTimeout(cap);
        if (deadline) clearTimeout(deadline);
        if (e) { this.retire(view); reject(e); } else resolve();
      };
    });
    // A rejection nobody awaits yet must not surface as an unhandled one.
    view.ready.catch(() => {});

    const start = async () => {
      const t = await client.request<CoreTerminal>("terminal.get", { terminal });
      if (view.dead) return;
      view.term = mirrorTerminal(t.cols, t.rows, this.o.history);
      deadline = setTimeout(() => settle(new Error(`herdr-core: no paint from ${terminal} within ${this.timeoutMs} ms`)), this.timeoutMs);
      const close = await client.observe(terminal, { cols: t.cols, rows: t.rows, history: this.o.history }, {
        onData: (bytes) => {
          const term = view.term;
          if (!term || view.dead) return;
          view.written = new Promise<void>((resolve) => term.write(bytes, resolve));
          // Only once the first paint has landed: before that, a read is
          // already waiting on `ready` and nothing has "changed" yet.
          if (painted) void view.written.then(() => this.changed(terminal));
          if (!painted) {
            if (!cap) cap = setTimeout(() => settle(), this.maxPaintMs);
            if (quiet) clearTimeout(quiet);
            quiet = setTimeout(() => settle(), this.quietMs);
          }
        },
        onResize: (cols, rows) => {
          const term = view.term;
          if (!term || (cols === term.cols && rows === term.rows)) return;
          if (!painted) term.resize(cols, rows); // the size the paint is drawn at
          else this.retire(view);
        },
        onClose: (reason) => {
          if (!painted) settle(reason);
          else {
            console.info(`herdr-core: live view of ${terminal} ended (${reason.message}); the next read attaches again`);
            this.retire(view);
          }
        },
      });
      view.close = close;
      if (view.dead) close(); // retired (idle, evicted, closeAll) while attaching
    };
    start().catch((e: unknown) => settle(e instanceof Error ? e : new Error(String(e))));
    return view;
  }
}
