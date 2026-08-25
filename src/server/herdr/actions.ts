import { request } from "@server/herdr/socket";
import type { HerdrPaneRead } from "@shared/herdr-api";
import type { AgentState, NavKey } from "@shared/types";

export type ReadSource = "detection" | "visible" | "recent_unwrapped";

/** Default line budget for an on-demand read. Output is never streamed. */
export const DEFAULT_READ_LINES = 120;

/**
 * Hard ceiling on an on-demand read.
 *
 * The line count is the ONLY client-supplied value that reaches a herdr
 * parameter (the agent id is validated against the store first), and spec §5
 * says output is "bounded by a line count" — so the bound has to be paddock's,
 * not the caller's. Unbounded, `{"lines": 1e9}` asks herdr for a billion lines
 * and buffers the answer in this process before pushing it down a ~250 ms
 * mobile link. 2000 lines is roughly 20x the default and comfortably more
 * transcript than a phone screen can be scrolled through, while staying a few
 * hundred KB in the worst case.
 */
export const MAX_READ_LINES = 2_000;

/** Default herdr-side budget for `agent.wait` after an answer is sent. */
export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

/**
 * Hard ceiling on that budget. No caller passes one today, but the value has
 * exactly the shape of `lines` — a number handed to a herdr parameter — and
 * clamping only the currently reachable one is how the next caller inherits
 * the unbounded version. A wait longer than a minute would pin a request
 * (and its herdr connection) open long past any confirmation worth showing.
 */
export const MAX_WAIT_TIMEOUT_MS = 60_000;

/**
 * Coerce a client-supplied line count into a bounded one.
 *
 * Two different treatments, deliberately:
 *  - **Out of range clamps.** A caller asking for more than the ceiling still
 *    wants as much output as it can get; the ceiling is paddock's policy, so
 *    serving `MAX_READ_LINES` answers the request honestly. Refusing would
 *    give the operator an error where output was available.
 *  - **Malformed falls back to the default.** `"60"`, `{}`, `NaN`, `-1`, `2.5`
 *    carry no inferable intent, and an optional field's default is the
 *    documented behaviour for a caller that did not supply it usefully.
 *
 * Never returns a value herdr could choke on: the result is always a positive
 * integer no greater than `MAX_READ_LINES`.
 */
export function resolveReadLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_READ_LINES;
  }
  return Math.min(value, MAX_READ_LINES);
}

/** Same rule, same reasoning, for the `agent.wait` budget. */
export function resolveWaitTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_WAIT_TIMEOUT_MS;
  }
  return Math.min(value, MAX_WAIT_TIMEOUT_MS);
}

/**
 * Margin added on top of the herdr-side wait budget when computing the
 * transport-level ceiling for `agent.wait`.
 *
 * `request()` defaults its own socket timeout to `HERDR_TIMEOUT_MS` (10s)
 * when no fourth argument is given. `waitUntilUnblocked` tells herdr it may
 * take up to `timeoutMs` (default 15s) to answer — if the call to `request`
 * omitted the fourth argument, the transport guard would fire at 10s while
 * herdr was still inside the 15s it was told it could use, producing a
 * false failure exactly in the window a real approve/reject confirmation
 * lands in. The transport ceiling must always exceed the herdr-side budget.
 */
const WAIT_TRANSPORT_MARGIN_MS = 5_000;

/**
 * Pick the read source by agent state: scrollback only for an IDLE agent,
 * the viewport for every other state.
 *
 * The rule this replaced ("blocked reads from visible, everything else from
 * scrollback") came from one probe of one blocked agent and was wrong. The
 * constraint herdr actually enforces is not about `blocked` at all — measured
 * against a live herdr 0.8.0, `recent`/`recent_unwrapped` succeed on a
 * *working* agent up to the pane's viewport height and fail with
 * `agent_not_idle` at exactly one line more:
 *
 *     visible/lines=2000 -> 64 rows   (the viewport)
 *     recent_unwrapped/63 -> OK
 *     recent_unwrapped/64 -> agent_not_idle
 *
 * A coding agent renders on the terminal's alternate screen, which keeps no
 * scrollback buffer. Anything past the viewport therefore has to be recovered
 * by herdr physically scrolling the pane and capturing — and, as its error
 * says, that "can only be captured by scrolling while idle".
 *
 * So the boundary is `requested lines > viewport rows`, and paddock cannot
 * evaluate it: no payload it reads carries the pane's row count, and the
 * default read (`DEFAULT_READ_LINES`, 120) is roughly double a typical
 * viewport, so the failing side is the normal case, not the edge. The only
 * predicate available on this side of the socket is the state — hence:
 *
 *  - `idle` — the one state in which the scroll is permitted at any depth, so
 *    it gets `recent_unwrapped` and the extra history that comes with it.
 *  - everything else — `visible`. It never scrolls, never fails, and is
 *    served from the live screen in ~2 ms. `working` and `blocked` are the
 *    states an operator most wants to look at; a viewport of real output
 *    beats an `agent_not_idle` error every time.
 *
 * `done` takes `visible` deliberately rather than by oversight. herdr derives
 * `done` from idle-plus-unseen, so its pane is *probably* scroll-eligible —
 * but `pane.report_agent` cannot report `done`, so it could not be produced
 * on a live socket and the guess could not be measured. Assuming it would
 * pass is the exact move that produced the rule this one replaces; a `done`
 * agent gets less scrollback instead of an error until someone can measure it.
 */
export function readSourceFor(state: AgentState): ReadSource {
  return state === "idle" ? "recent_unwrapped" : "visible";
}

/**
 * The source to actually request, given whether the caller wants scrollback.
 *
 * `readSourceFor` answers "what is the richest source this state permits".
 * That is not the same question as "what should the FIRST read use", and
 * conflating them is what made opening an idle agent slow: `recent_unwrapped`
 * recovers history by physically scrolling the pane, which costs ~35 ms per
 * line past the viewport — so a 120-line default on an agent with real
 * scrollback is seconds of blank screen before anything is drawn.
 *
 * `visible` is flat at ~2 ms for any line count and never fails, so it is what
 * a first paint should ask for. Scrollback is a second, explicit request the
 * UI makes once the operator is already looking at something.
 */
export function resolveSource(state: AgentState | null, scrollback: boolean): ReadSource {
  // A shell pane is on the NORMAL screen, so it has a real scrollback buffer
  // and `recent_unwrapped` is ~2ms for 400 lines — measured. That is the exact
  // opposite of an agent pane, which renders on the alternate screen and costs
  // ~35ms per line past the viewport. So the cheap source for a shell is the
  // expensive one for an agent, and the state is what tells them apart.
  //
  // Reached in production from `readPane` below, which asks rather than
  // hardcoding: this is the one place the rule is written down.
  if (state === null) return "recent_unwrapped";

  return scrollback ? readSourceFor(state) : "visible";
}

/**
 * Lines to request for a HISTORY read, and the ceiling it needs.
 *
 * Both are measured, and both are paddock's rather than the caller's.
 *
 * 400 is a sweet spot with a cliff on either side. Measured on herdr 0.8.0
 * against real agents, `recent` at 400 returns ~400 lines; the same call at
 * 2000 returns SIXTY-THREE — fewer than the smaller request — after ~16s. So
 * a caller cannot be allowed to ask for more, because more is worse.
 *
 * The timeout exists because herdr recovers alternate-screen history by
 * physically scrolling the pane, which took 11-14 SECONDS in every
 * measurement. Under the default 10s transport ceiling this call aborts every
 * single time; history is simply unreachable without raising it. The live
 * read keeps the default deliberately — `visible` answers in ~2ms, and giving
 * it a 25s ceiling would turn a wedged socket into a 25s hang on the one path
 * that has to stay instant.
 */
export const HISTORY_LINES = 400;

export function historyTimeoutMs(): number {
  return 25_000;
}

/**
 * The line count for a read. A history read ignores the caller entirely; a
 * live read clamps them, as it always has.
 */
export function readLinesFor(history: boolean, lines?: number): number {
  return history ? HISTORY_LINES : resolveReadLines(lines);
}

export interface HerdrActions {
  readOutput(
    target: string, state: AgentState, lines?: number, scrollback?: boolean,
  ): Promise<{ lines: string[]; source: ReadSource }>;
  /**
   * Read a pane that has no agent — a plain shell. `HISTORY_LINES`, and the
   * source it gets from `resolveSource(null, true)`, which is always
   * `recent_unwrapped`: a shell is on the normal screen, where that source is
   * ~2ms instead of the ~35ms/line it costs an agent's alternate screen.
   */
  readPane(paneId: string): Promise<{ lines: string[]; source: ReadSource }>;
  readDetection(target: string): Promise<string>;
  sendOptionKey(target: string, key: string): Promise<void>;
  /**
   * Send one navigation key. Separate from `sendOptionKey` because the two
   * carry different authority: an option digit answers a prompt paddock
   * believes it parsed, while a nav key only moves the agent's own cursor and
   * asserts nothing. `NavKey`'s members are herdr's key names verbatim, so
   * there is no mapping table here to drift out of date.
   */
  sendNavKey(target: string, key: NavKey): Promise<void>;
  sendReply(target: string, text: string): Promise<void>;
  /**
   * Type into a pane with no agent — the mirror of `sendReply`'s
   * `agent.prompt`, for a shell. Parameter is `pane_id`, not `target`: the
   * agent-side methods take `target`, and the two are not interchangeable —
   * measured, and already the cause of one shipped bug in this repo.
   */
  sendPaneText(paneId: string, text: string): Promise<void>;
  /**
   * Send one navigation key to a pane with no agent — the mirror of
   * `sendNavKey`. The route reuses `isNavKey`'s allowlist rather than trusting
   * a second one: a bare shell is, if anything, a larger lever than an
   * agent's prompt, so the same closed set applies.
   */
  sendPaneKey(paneId: string, key: NavKey): Promise<void>;
  waitUntilUnblocked(target: string, timeoutMs?: number): Promise<void>;
}

/** Binds the socket path once so routes can take an injectable object. */
export function createActions(socketPath: string): HerdrActions {
  return {
    async readOutput(target, state, lines, scrollback = false) {
      const source = resolveSource(state, scrollback);
      // Clamped here as well as at the route boundary: this is the function
      // that builds the herdr params, so the bound holds for every caller,
      // not only the one that happens to validate first.
      const bounded = readLinesFor(scrollback, lines);
      // Typed with the generated envelope, not an inline shape. The inline
      // `{ text?: string }` this replaced described a response herdr has
      // never sent, and an optional field made the mismatch resolve to `""`
      // instead of failing anywhere.
      // ANSI is KEPT, and parsed in the browser (`web/ansi.ts`). In agent
      // output the colour is the structure — headings, diff markers, the
      // highlight on the selected option — so `strip_ansi: true` was not a
      // neutral simplification: it flattened every transcript into one grey
      // wall before the UI ever saw it. Verified against herdr 0.8.0, which
      // answers this call with truecolor (`38;2;r;g;b`) plus bold and italic.
      //
      // `readDetection` below deliberately keeps stripping, because its
      // consumer is the prompt PARSER, and escapes there would break the
      // option matching rather than inform it.
      // A history read gets its own, much larger ceiling — see historyTimeoutMs.
      const res = await request<HerdrPaneRead>(socketPath, "agent.read", {
        target, source, lines: bounded, format: "ansi", strip_ansi: false,
      }, scrollback ? historyTimeoutMs() : undefined);
      const text = res.read.text;
      // "".split("\n") is [""], not [] — a genuinely empty pane must report
      // no lines, not one blank line.
      //
      // The trailing CR is dropped because herdr's `ansi` format returns CRLF
      // endings, and a bare CR left inside a `white-space: pre` block is
      // rendered as a line break by some engines and as a glyph by others —
      // so leaving it in means the transcript looks different on the phone
      // that matters (iOS Safari) than on the desktop it was checked on.
      return {
        lines: text === "" ? [] : text.split("\n").map((l) => l.replace(/\r$/, "")),
        source,
      };
    },

    async readPane(paneId) {
      // `pane.read`, not `agent.read`: the latter returns `agent_not_found`
      // for a pane with no harness — measured. Note the parameter is
      // `pane_id` here and `target` there; they are not interchangeable.
      //
      // Agents deliberately stay on `agent.read` (design doc §8): it refuses
      // `recent_unwrapped` on a non-idle agent with `agent_not_idle`, a
      // herdr-side guard against scrolling a live agent's pane that paddock
      // would otherwise have to maintain alone.
      //
      // The source is ASKED FOR, not hardcoded. `resolveSource` is where the
      // "a shell reads from scrollback" rule lives, and the `state: null`
      // branch exists for exactly this call site — hardcoding the answer here
      // left the rule written down twice, with only a test reaching the copy
      // that is supposed to be authoritative.
      const source = resolveSource(null, true);
      // The default 10s ceiling, deliberately — NOT `historyTimeoutMs()`.
      // That override exists because an agent's alternate screen is recovered
      // by physically scrolling the pane, 11-14s in every measurement. A
      // shell is on the normal screen with a real buffer: 400 lines came back
      // in 2ms. A 25s ceiling here would buy nothing and would turn a wedged
      // socket into a 25s hang on a path that answers instantly when healthy.
      const res = await request<HerdrPaneRead>(socketPath, "pane.read", {
        pane_id: paneId, source, lines: HISTORY_LINES,
        format: "ansi", strip_ansi: false,
      });
      const text = res.read.text;
      return {
        lines: text === "" ? [] : text.split("\n").map((l) => l.replace(/\r$/, "")),
        source,
      };
    },

    async readDetection(target) {
      const res = await request<HerdrPaneRead>(socketPath, "agent.read", {
        target, source: "detection", lines: 60, format: "text", strip_ansi: true,
      });
      return res.read.text;
    },

    async sendOptionKey(target, key) {
      await request(socketPath, "agent.send_keys", { target, keys: [key] });
    },

    async sendNavKey(target, key) {
      await request(socketPath, "agent.send_keys", { target, keys: [key] });
    },

    async sendReply(target, text) {
      await request(socketPath, "agent.prompt", { target, text });
    },

    async sendPaneText(paneId, text) {
      // `pane.send_text`, the mirror of the agent path's `agent.prompt`.
      // Parameter is `pane_id`, not `target` — measured; they are not
      // interchangeable.
      await request(socketPath, "pane.send_text", { pane_id: paneId, text });
    },

    async sendPaneKey(paneId, key) {
      await request(socketPath, "pane.send_keys", { pane_id: paneId, keys: [key] });
    },

    async waitUntilUnblocked(target, timeoutMs) {
      const budget = resolveWaitTimeoutMs(timeoutMs);
      // Wait on LEAVING blocked. Declining an option settles the agent on
      // `idle`, so a `working`-only wait reports a false failure on every
      // rejection — confirmed during the probe, where answering "Yes" also
      // settled on idle once the command finished.
      await request(socketPath, "agent.wait", {
        target, until: ["working", "idle", "done"], timeout_ms: budget,
      }, budget + WAIT_TRANSPORT_MARGIN_MS);
    },
  };
}
