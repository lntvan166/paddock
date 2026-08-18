import { request } from "@server/herdr/socket";
import type { HerdrPaneRead } from "@shared/herdr-api";
import type { AgentState } from "@shared/types";

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

export interface HerdrActions {
  readOutput(target: string, state: AgentState, lines?: number): Promise<{ lines: string[]; source: ReadSource }>;
  readDetection(target: string): Promise<string>;
  sendOptionKey(target: string, key: string): Promise<void>;
  sendReply(target: string, text: string): Promise<void>;
  waitUntilUnblocked(target: string, timeoutMs?: number): Promise<void>;
}

/** Binds the socket path once so routes can take an injectable object. */
export function createActions(socketPath: string): HerdrActions {
  return {
    async readOutput(target, state, lines) {
      const source = readSourceFor(state);
      // Clamped here as well as at the route boundary: this is the function
      // that builds the herdr params, so the bound holds for every caller,
      // not only the one that happens to validate first.
      const bounded = resolveReadLines(lines);
      // Typed with the generated envelope, not an inline shape. The inline
      // `{ text?: string }` this replaced described a response herdr has
      // never sent, and an optional field made the mismatch resolve to `""`
      // instead of failing anywhere.
      const res = await request<HerdrPaneRead>(socketPath, "agent.read", {
        target, source, lines: bounded, format: "text", strip_ansi: true,
      });
      const text = res.read.text;
      // "".split("\n") is [""], not [] — a genuinely empty pane must report
      // no lines, not one blank line.
      return { lines: text === "" ? [] : text.split("\n"), source };
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

    async sendReply(target, text) {
      await request(socketPath, "agent.prompt", { target, text });
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
