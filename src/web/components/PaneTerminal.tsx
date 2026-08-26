import {
  Fragment, useCallback, useEffect, useImperativeHandle, useRef, useState,
  type CSSProperties, type ReactNode, type Ref,
} from "react";
import type { ActionResult, NavKey, OutputResult, PaneOutput } from "@shared/types";
import { parseAnsi, type AnsiSpan } from "@web/ansi";
import { groupLines } from "@web/lines";
import { mergeSnapshot } from "@web/history";
import { historyFor, rememberHistory, rememberScreen, screenFor } from "@web/pane-cache";
import { applyPatch, digestOf } from "@shared/screen";
import { RATE_MS, readPrefs, writePref, type KeypadPref, type RatePref } from "@web/prefs";
import { RequestFailed } from "@web/api";
import { Button } from "@web/components/shadcn/button";
import { Input } from "@web/components/shadcn/input";
import { Keypad, KeypadToggle } from "@web/components/ui/Keypad";
import { LaunchNotice } from "@web/components/LaunchNotice";

/**
 * A pane's transcript, and everything that keeps it live.
 *
 * A SHELL AND AN AGENT ARE NOT TWO KINDS OF THING. They are one pane at two
 * moments: you open a shell, type `claude`, and the same `pane_id` becomes an
 * agent. So everything here — the read loop, the ANSI pass, the scroll
 * handling, the reconstructed scrollback — works for any pane, and the
 * agent-only controls (prompt options, keypad, state dot, send-as-reply) are
 * slots that `AgentTerminal` fills when there is an agent to drive.
 *
 * That is why this file exists at all. `AgentTerminal.tsx` was 1050 lines, and
 * the shell case gave the split an objective seam rather than an invented one.
 * There is exactly ONE transcript renderer in the project, and this is it —
 * two would drift, which would defeat the whole point.
 */

/**
 * Undefined for an unstyled span, so the common run of plain text costs no
 * style object at all — a full pane is on the order of a thousand spans and
 * most of them carry nothing.
 */
function styleFor(s: AnsiSpan): CSSProperties | undefined {
  if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline) return undefined;
  return {
    color: s.fg,
    background: s.bg,
    fontWeight: s.bold ? 700 : undefined,
    // `dim` as opacity rather than a second palette: it composes with whatever
    // foreground is already set, which is what the attribute means.
    opacity: s.dim ? 0.7 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: s.underline ? "underline" : undefined,
  };
}

/**
 * Whether the pane reflows long lines to the viewport.
 *
 * A choice rather than a heuristic, and deliberately so. Measured across five
 * live agents: of the lines too long for a phone, 57% are STRUCTURED — box
 * drawing, or table rows whose columns carry meaning positionally — and 43%
 * are prose or code that reflows perfectly. No per-line rule gets both right.
 * Wrap everything and the majority of long lines fold into nonsense; wrap
 * nothing and half the transcript needs sideways scrolling to read a sentence.
 *
 * So the operator decides, per pane, at any moment. The stored value is owned
 * by `@web/prefs` (key `paddock.term.wrap`) — this component reads and writes
 * through it rather than touching `localStorage` directly.
 */

/** Distance from the bottom, in px, still counted as "following the tail". */
const STICK_THRESHOLD_PX = 48;

/**
 * Distance from the top, in px, still counted as "at the top" — the state that
 * offers "Show earlier".
 *
 * Deliberately generous. A thumb-flick to the top of a scroller rarely lands on
 * exactly 0, and a control that appears only at a pixel-perfect position reads
 * as broken rather than as conditional. Smaller than STICK_THRESHOLD_PX because
 * the tail is a place you MEAN to be while output keeps arriving, whereas the
 * top is a place you arrive at once and then act.
 */
const TOP_THRESHOLD_PX = 24;

/**
 * Adaptive refresh bounds.
 *
 * A fixed interval is wrong in both directions, because the AGENT STATE DOES
 * NOT PREDICT whether the screen is changing. Measured at 1s sampling: an
 * agent actively drawing output changed on 100% of samples, an idle one on 7%,
 * and a `working` agent sitting between tool calls on 0%. Polling all three at
 * 3s is simultaneously too slow to follow the first and pure waste on the
 * other two.
 *
 * So the interval follows observed change instead: back off while the server
 * keeps answering `unchanged`, snap back to the floor the moment the screen
 * moves.
 *
 * The FLOOR is what governs how coarse an update looks. Measured against an
 * agent producing a burst of output, a 1s poll replaced up to 86% of the
 * screen in a single step — which is the "jumps rather than flows" complaint,
 * and no rendering change can fix it: the step size IS the poll interval. At
 * 250ms the same burst arrives in roughly four smaller steps.
 *
 * Paying for that floor only while output is moving is the whole point of the
 * backoff. A quiet pane still reaches the 10s ceiling and costs almost
 * nothing, because a revalidated poll is 38 B. Doubling (rather than 1.5x)
 * keeps the climb to the ceiling at six steps from the lower floor, so a pane
 * that goes quiet stops costing requests about as quickly as it did before.
 */
export const MIN_REFRESH_MS = 250;
export const MAX_REFRESH_MS = 10_000;
const REFRESH_BACKOFF = 2;

/**
 * The floor for a pane with NO agent, which is a different bargain entirely.
 *
 * An agent poll is validated against the in-memory store and costs herdr one
 * `pane.read` (~2 ms). A shell poll cannot be: a shell pane is deliberately
 * absent from the store (§3), so the ONLY authority that can validate the id
 * is the session tree — `POST /api/panes/:id/output` pays a
 * `session.snapshot` (~17-19 ms, measured) before every read. That is roughly
 * ten times the herdr work per request, and neither weakening the validation
 * nor caching the tree is on the table: the design refuses both.
 *
 * So the RATE is matched instead of the interval. At 1000 ms a watched shell
 * asks herdr for ~21 ms of work per second; an agent at its 250 ms floor asks
 * for ~8 ms per second. Same order, where the same floor would have been 10x.
 *
 * And the 250 ms floor's own justification does not transfer. It exists
 * because an agent producing a burst of output redraws most of the screen
 * between polls, so the interval IS the visual step size. A shell is a pane
 * sitting at a prompt: it changes when a person types at the desk or a command
 * prints, and a person cannot perceive their own keystroke arriving 300 ms
 * later on a second screen as "jumpy" the way they perceive a paragraph of
 * agent output landing in one block.
 *
 * The CEILING and the doubling are untouched, so a shell nobody is typing in
 * still climbs to `MAX_REFRESH_MS` — see `applyResult` for how "changed" is
 * decided on a route that has no server-side revalidation to answer it.
 *
 * WHAT THIS REASONING DOES NOT COVER, recorded rather than left implied. All
 * of the above is about herdr work per second. It says nothing about bytes to
 * the phone or DOM nodes on it, and there the two paths are NOT the same
 * order:
 *
 * - An agent at the ceiling sends its digest and gets `unchanged` back — 38 B,
 *   nothing parsed, nothing re-rendered.
 * - A shell at the ceiling has no server-side revalidation to ask for, so it
 *   ships a full `recent_unwrapped` body — 400 lines of unstripped ANSI —
 *   every 10 s, and `parseAnsi` walks all of it before `digestOf` concludes
 *   nothing changed. A quiet shell is therefore CHEAP for herdr and NOT cheap
 *   for the link or the device, which is the opposite of the agent case and
 *   the exact bargain the 4x floor was chosen against.
 *
 * The cheap fix is known and deliberately not taken here: give
 * `POST /api/panes/:id/output` the same client-supplied digest the agent route
 * already takes, and let it answer 304-style. It needs no new state — the
 * digest arrives in the request — and it would make a quiet shell cost what a
 * quiet agent costs. Recorded as follow-up work; do not read this comment as
 * a claim that it has been done.
 *
 * AND IT IS NOT ONLY READS. All of the above budgets the `session.snapshot`
 * per POLL, which is how the number was arrived at — but the validation is
 * per REQUEST, and every shell WRITE goes through the same guard: each
 * keystroke on the pad is one `session.snapshot` plus one `pane.send_keys`,
 * and one tap on Send is one snapshot plus `pane.send_text` plus
 * `pane.send_keys`. So a burst of typing costs herdr the same ~19 ms per tap
 * that a poll does, on top of the polling. That is the right trade for an
 * operator-initiated action — a person cannot tap faster than the poll floor
 * for long — but the digest fix above would not touch it, and nothing here
 * throttles it.
 */
export const SHELL_MIN_REFRESH_MS = 1_000;

/**
 * The operator's refresh preset, as a floor in milliseconds.
 *
 * Raises the FLOOR only — the backoff ceiling (`MAX_REFRESH_MS`) and the
 * doubling that climbs toward it are untouched by the preset, so a metered
 * connection still quiets down on an idle pane exactly as before. Named
 * points from `@web/prefs`, not a free numeric field: see `RATE_MS` there for
 * why.
 */
export function floorFor(rate: RatePref): number {
  return RATE_MS[rate];
}

/**
 * The next poll delay, given the current one, whether the screen moved, and
 * the floor to snap back to.
 *
 * Pure and exported so the ladder is testable without a live agent and
 * without a DOM — the component holds it in a ref, which no unit test can
 * reach. `floor` defaults to `MIN_REFRESH_MS` so every existing caller (and
 * `tests/refresh-backoff.test.ts`, which predates the refresh preset) keeps
 * its prior behaviour unchanged.
 */
export function nextRefreshMs(current: number, changed: boolean, floor: number = MIN_REFRESH_MS): number {
  if (changed) return floor;
  return Math.min(MAX_REFRESH_MS, Math.round(current * REFRESH_BACKOFF));
}

/** Settled lines revealed per tap of "show earlier" from reconstruction. */
export const HISTORY_PAGE = 200;

/**
 * One read of a pane's screen.
 *
 * `since` is the digest of the screen the caller is already holding, or null
 * to ask for a whole screen unconditionally. A loader that has no
 * server-side revalidation to offer (the shell route has none) simply ignores
 * it and returns a `PaneOutput`; see `applyResult`.
 */
export type PaneLoad = (since: string | null) => Promise<OutputResult | PaneOutput>;

/**
 * What "Show earlier" needs in order to be rendered by somebody else.
 *
 * `AgentTerminal` replaces the built-in button when — and only when — the
 * agent's own journal is in play, because a journal page is fetched rather
 * than revealed. Everything the two variants share (where the button may
 * appear, how the scroll survives content arriving ABOVE the viewport, and the
 * reconstructed page itself) stays here, so the fallback path is not a second
 * copy of this file's logic.
 */
export interface EarlierContext {
  /** Reconstructed lines still held back. 0 once all of them are on screen. */
  remaining: number;
  /** Snapshot gaps in the reconstructed scrollback. */
  gaps: number;
  /** Reveal another page of RECONSTRUCTED scrollback, pinning the scroll. */
  revealMore: () => void;
  /**
   * Pin the scroll position across content about to be PREPENDED.
   *
   * Call before the transcript grows; call the returned function after. Growth
   * at the top would otherwise shove the screen down and lose the operator's
   * place.
   */
  pinScroll: () => () => void;
}

/** What an owner can push into an already-mounted transcript. */
export interface PaneTerminalHandle {
  /**
   * Replace the screen with one an ACTION just returned (`/key`, `/text`).
   *
   * Imperative on purpose: the screen belongs to this component, and the
   * alternative — waiting for the next poll — would leave the pane a whole
   * interval behind the key the operator just pressed, on the one screen
   * where the delay is attributable to them.
   */
  apply: (lines: string[]) => void;
}

export interface PaneTerminalProps {
  /** herdr's `pane_id`. The same string as an agent id, because they are the
   *  same thing at two moments. */
  paneId: string;
  /** The pane's name, as the header shows it and as the region is labelled. */
  title: string;
  onBack: () => void;
  load: PaneLoad;
  /** Accessible name for the back control — where "back" actually goes
   *  differs between a pane the dashboard lists and one only Spaces can. */
  backLabel?: string;
  /** Rendered inside `.term-title`, after the name: a state dot, a pill. */
  headerExtra?: ReactNode;
  /** Between the transcript and the view controls: feedback, prompt options. */
  beforeControls?: ReactNode;
  /** Inside the view-controls row, between Wrap and Refresh. */
  controls?: ReactNode;
  /** After the view controls: the keypad, the reply box. */
  afterControls?: ReactNode;
  /**
   * Lines shown ABOVE the live screen, replacing the reconstructed reveal.
   *
   * The two sources never coexist for one pane (design decision 18). Undefined
   * means the built-in reconstructed path is in play.
   */
  revealed?: string[];
  /**
   * Replaces the built-in "Show earlier" button.
   *
   * Return `undefined` to express NO OPINION — the built-in reconstructed
   * button then decides for itself. Return `null` to say there is deliberately
   * nothing to offer, which is not the same claim: an agent whose journal has
   * run out shows no button even though reconstructed lines exist behind it,
   * because the two sources never mix for one pane (design decision 18).
   */
  earlier?: (ctx: EarlierContext) => ReactNode | undefined;
  /** An action is in flight: skip polls, and disable Refresh. */
  paused?: boolean;
  /** Never poll faster than this, whatever the operator's preset allows. */
  minIntervalMs?: number;
  /**
   * Type a command into THIS pane, when it has no agent — the shell's own
   * reply box calls this. Injected exactly like `load`, so the tests need no
   * network and so the component itself never has to know the route.
   *
   * `submit` says whether the command should also be RUN. The reply box always
   * passes `true`, because that is what a button labelled Send means to the
   * person tapping it; the parameter is here so the promise the button makes is
   * visible at this seam rather than buried in the route. `pane.send_text` on
   * its own types and does not submit.
   *
   * Undefined for an agent pane: `AgentTerminal` renders its OWN reply box
   * through `afterControls`, wired to `sendText` (`agent.prompt` — answering
   * a prompt) instead of this (`pane.send_text` — typing at a shell). Same
   * control, different verb, decided by the pane's `harness` (§16.3).
   */
  sendText?: (text: string, submit: boolean) => Promise<ActionResult>;
  /**
   * Send one nav key to THIS pane, when it has no agent — the mirror of
   * `sendText` above, for `pane.send_keys` in place of `agent.send_keys`.
   * Renders the shared `Keypad` when present; `AgentTerminal` still owns its
   * own keypad instance, wired to its own `sendKey`.
   */
  sendKey?: (key: NavKey) => Promise<ActionResult>;
  ref?: Ref<PaneTerminalHandle>;
}

export function PaneTerminal({
  paneId, title, onBack, load,
  backLabel = "Back to agents",
  headerExtra, beforeControls, controls, afterControls,
  revealed: revealedOverride, earlier,
  paused = false, minIntervalMs = 0,
  sendText: onSendText, sendKey: onSendKey,
  ref,
}: PaneTerminalProps) {
  // Seeded from the cache, so a re-opened pane has its screen on the first
  // render rather than after a round trip.
  const [output, setOutput] = useState<string[]>(() => screenFor(paneId)?.lines ?? []);
  // Digest of the screen currently held, sent with each poll so the server can
  // answer "unchanged" instead of resending ~10 KB the client already has.
  const digestRef = useRef<string | null>(screenFor(paneId)?.digest ?? null);
  const [error, setError] = useState<string | null>(null);
  // A poll that failed while output is already on screen. Distinct from
  // `error`, which means the read failed with nothing to show.
  const [stalled, setStalled] = useState(false);
  const [wrap, setWrap] = useState(() => readPrefs().wrap);
  // Read once: Settings is a separate full-screen view (App.tsx unmounts this
  // component to show it), so there is no live pref change to react to while
  // a pane stays open.
  const [fontPx] = useState(() => readPrefs().fontPx);
  const [shownHistory, setShownHistory] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);
  // Whether the operator is following the tail. Read BEFORE the DOM updates
  // and applied after, so replacing the screen does not yank someone who has
  // deliberately scrolled up to read earlier output.
  const stick = useRef(true);
  /**
   * Whether the operator has scrolled to the top of the transcript.
   *
   * Gates "Show earlier", which used to be rendered whenever more history
   * existed — so on a long-running agent it was permanently on screen, costing
   * a row of transcript on every pane for an action nobody takes until they
   * have read back that far.
   *
   * State, not a ref: this one has to re-render, which is the whole point.
   *
   * Starts `true` for the case where the output is shorter than the pane. There
   * is no scrollbar then, no scroll event ever fires, and top and bottom are the
   * same place — a short pane with earlier history to fetch must still offer it.
   */
  const [atTop, setAtTop] = useState(true);

  /**
   * The shell's own controls (§16.3) — a reply box and a keypad, present only
   * when `onSendText` is supplied. Held here rather than in a wrapper
   * component because there is no `ShellTerminal` the way `AgentTerminal`
   * wraps the agent case: a shell has no agent-only state (no prompt, no
   * journal, no state dot) to justify one, so this is the whole of it.
   */
  const [shellReply, setShellReply] = useState("");
  const [shellBusy, setShellBusy] = useState(false);
  /**
   * A FAILURE, or nothing — not an `ActionResult`.
   *
   * It was typed as one, which meant the renderer carried an `ok ? "Sent." :
   * detail` branch whose success half nothing could ever reach: every write to
   * it was `ok: false`. There is no success message to write either, now that
   * Send runs the command — what success looks like is the command's own output
   * arriving in the transcript, and a "Sent." line under it would be paddock
   * claiming credit for something the pane already shows.
   */
  const [shellFeedback, setShellFeedback] = useState<{ detail: string } | null>(null);
  const [shellKeypad, setShellKeypad] = useState<KeypadPref>(() => readPrefs().keypad);

  // Mirrors `paused` (and, for a shell, its own send) for the polling
  // interval, which must read the CURRENT value without being torn down and
  // rebuilt every time a key press flips it.
  const pausedRef = useRef(false);
  useEffect(() => { pausedRef.current = paused || shellBusy; }, [paused, shellBusy]);

  // The floor the backoff snaps back to, from the operator's refresh preset
  // and whatever the caller's read costs. A ref for the same reason as
  // `intervalRef` below: read once (see the `fontPx` comment above for why
  // once is enough), and read by callbacks that must not be rebuilt every
  // render to pick up a value that cannot change under them anyway.
  //
  // Read through a LAZY initializer, like `wrap` and `fontPx` above.
  // `useRef(floorFor(readPrefs().rate))` evaluates its argument on every
  // render and throws the result away on all but the first — four
  // localStorage reads per render, in a component that re-renders every
  // 250 ms on the Live preset.
  const [floorMs] = useState(() => Math.max(floorFor(readPrefs().rate), minIntervalMs));
  const floorRef = useRef(floorMs);

  // Current backoff position. A ref, not state: changing it must not re-render
  // the pane, and the polling loop has to read the latest value without being
  // rebuilt around it.
  const intervalRef = useRef(floorRef.current);

  const apply = useCallback((lines: string[], digest: string | null = null) => {
    digestRef.current = digest;
    rememberScreen(paneId, { lines, digest });
    // Every live screen is folded into the reconstructed scrollback. Only
    // lines that have provably left the viewport are committed — see
    // `web/history.ts`, which is what stops a redrawn spinner being pasted
    // into history on every poll.
    rememberHistory(
      paneId,
      mergeSnapshot(historyFor(paneId) ?? { settled: [], gaps: 0 }, lines),
    );
    setOutput(lines);
    setError(null);
    setStalled(false);
    // Back to the floor, for the same reason `onVisible` below resets it: an
    // applied screen means an ACTION just happened, and whatever backoff had
    // built up was measured against a pane nobody was touching. A shell that
    // has just been given a command is the least likely pane in the session to
    // stay unchanged, and it is the one moment the operator is watching.
    //
    // Without this, the route's settled screen lands instantly and then the
    // NEXT frame — the command's actual output — waits out a backoff of up to
    // MAX_REFRESH_MS. That is half the "terminal is slow" report; the other
    // half was the route not answering with a screen at all.
    intervalRef.current = floorRef.current;
  }, [paneId]);

  useImperativeHandle(ref, () => ({ apply }), [apply]);

  /**
   * A read that succeeded but brought no new screen.
   *
   * Clears BOTH signals, and the `error` half is the part that is easy to
   * miss: once the banner is up, a pane whose digest still matches returns
   * early without ever reaching `apply`, so nothing cleared it — a quiet pane
   * kept showing "Could not load output" indefinitely while every read
   * underneath it was succeeding. A successful revalidation is proof the link
   * is alive, which is exactly what the banner claims it is not.
   */
  const settled = useCallback(() => {
    setError(null);
    setStalled(false);
  }, []);

  /**
   * Applies a read that may be a "nothing changed" answer.
   *
   * `unchanged` must NOT fall through to `apply([])` — that would blank the
   * pane on precisely the responses that mean it is still correct. It clears
   * `stalled` though: a successful revalidation is proof the link is alive.
   *
   * Returns false when a patch could not be verified, which tells the caller
   * to fetch a whole screen. Reported rather than thrown: a failed patch is a
   * recoverable transport hiccup, not an error worth showing the operator.
   */
  const applyResult = useCallback((res: OutputResult | PaneOutput): boolean => {
    if ("unchanged" in res && res.unchanged) {
      // Nothing moved: wait longer before asking again.
      intervalRef.current = nextRefreshMs(intervalRef.current, false);
      settled();
      return true;
    }

    if ("patch" in res) {
      // The screen moved, so it may well move again — follow it closely.
      intervalRef.current = nextRefreshMs(intervalRef.current, true, floorRef.current);
      const base = screenFor(paneId)?.lines ?? [];
      const next = applyPatch(base, res.patch);
      // Self-check. The server states the digest the patch should produce, so
      // a patch applied against the wrong base — or a bug in either half —
      // is caught here instead of showing output that never existed.
      if (digestOf(next) !== res.patch.digest) return false;
      apply(next, res.patch.digest);
      return true;
    }

    // A response WITHOUT a digest comes from a route that cannot revalidate:
    // `POST /api/panes/:id/output` has no screen cache to revalidate against,
    // because a shell pane is not in the store that owns one. Left there, the
    // backoff would read every such read as "changed", and a shell nobody is
    // typing in would poll at its floor forever — the one case the ladder
    // exists to make cheap. So the comparison is done here instead, and
    // "changed" means the same thing on both routes.
    //
    // The agent route always states a digest, so this cannot alter its
    // behaviour: `"digest" in res` short-circuits before the held value is
    // ever consulted.
    const digest = "digest" in res ? res.digest : digestOf(res.lines);
    const changed = "digest" in res || digest !== digestRef.current;
    intervalRef.current = nextRefreshMs(intervalRef.current, changed, floorRef.current);
    if (!changed) {
      settled();
      return true;
    }
    apply(res.lines, digest);
    return true;
  }, [paneId, apply, settled]);

  /**
   * The re-read used by the poll. What it costs depends entirely on which
   * route `load` is bound to, and the two are not comparable:
   *
   * - **An agent** (`POST /api/agents/:id/output`) asks for `visible`, never
   *   scrollback, and sends `digestRef.current` so the server can answer
   *   `unchanged` — 38 B on a quiet pane.
   * - **A shell** (`POST /api/panes/:id/output`) asks for
   *   `recent_unwrapped` at `HISTORY_LINES` (400 lines, ANSI, unstripped) on
   *   EVERY poll, with no server-side revalidation to answer against, and the
   *   digest is compared here instead. So "unchanged" still stops the screen
   *   from being replaced and still backs the interval off — but the bytes
   *   were already shipped and re-parsed. See `SHELL_MIN_REFRESH_MS`.
   *
   * A failed poll does NOT clear the screen and does NOT raise the error
   * banner — the last good output is still the best thing to show. It is not
   * swallowed either: `stalled` puts a marker in the header, so a pane that
   * has quietly stopped updating says so rather than looking current.
   */
  const refresh = useCallback(async () => {
    try {
      const ok = applyResult(await load(digestRef.current));
      // A patch that failed its self-check: ask for a whole screen, without a
      // digest so the server cannot answer with another patch.
      if (!ok) applyResult(await load(null));
    } catch {
      setStalled(true);
    }
  }, [load, applyResult]);

  /**
   * The opening read. Identical to the poll's read, minus the `since` digest —
   * whatever `load` asks for, it asks for the same thing here.
   *
   * For an AGENT that is `visible` only: the live viewport, which is exactly
   * what the terminal shows. It used to make a SECOND, scrollback read for
   * `idle` agents to add history. That was removed, because the poll asks for
   * `visible` and the two sources return different content: the digest could
   * never match, and suppressing the poll to avoid the pane oscillating left
   * it frozen. The justification given at the time — "an idle agent by
   * definition is not producing output" — is simply false. `idle` means READY
   * FOR INPUT, and a pane changes whenever anyone types at the desk. An
   * operator watching a frozen screen has no way to tell it from a quiet one.
   *
   * For a SHELL there is no such split to get wrong: `resolveSource(null, _)`
   * answers `recent_unwrapped` for every read of a shell, so the opening read
   * and the poll ask for the same 400 lines from the same real scrollback
   * buffer, and the digest can always match.
   */
  const open = useCallback(async () => {
    try {
      // No `since` on the opening read: the point is to paint, and a cached
      // screen from a previous visit may be minutes stale even when its
      // digest still matches whatever it matched then.
      applyResult(await load(null));
    } catch (err) {
      // A REFUSAL is not a failure. `409` is the pane route's answer for "this
      // pane has an agent now" — a promotion in flight, from a shell someone
      // just typed `claude` into, or from a cold deep link whose tree read
      // beat the websocket snapshot. `App` swaps in `AgentTerminal` a beat
      // later, and the screen already on display stays true the whole time.
      // So this is treated exactly as a failed POLL is: keep the transcript,
      // mark the pane as not updating, and never raise a banner that would
      // put an internal route name in front of the operator.
      if (err instanceof RequestFailed && err.status === 409) {
        setStalled(true);
        return;
      }
      // Surfaced where the output would have been. A blank pane that means
      // "the read failed" is indistinguishable from one that means "no
      // output", and this project treats a silent break as the defect.
      setError(String(err instanceof Error ? err.message : err));
    }
  }, [load, applyResult]);

  // Refetch on open and whenever `load` changes identity — which is how
  // `AgentTerminal` asks for a re-read when the agent's state moves: a
  // transcript frozen at the moment the view opened is the thing an operator
  // is most likely to misread as current.
  useEffect(() => {
    void open();
  }, [open]);

  /**
   * Keep the open pane live.
   *
   * Spec §5's "never streamed" rule is about pushing SEVERAL terminals
   * continuously down a ~250 ms link — the thing named as the one way to make
   * paddock genuinely slow. This is one pane, only while its screen is open.
   * Without it a working agent's transcript is frozen at the moment the view
   * opened, which is worse than slow: it is confidently wrong, and
   * indistinguishable from an agent that has stopped.
   *
   * Paused when the document is hidden — a phone with the browser backgrounded
   * must not poll a tunnel every few seconds for a screen nobody is looking at.
   * Skipped while `paused`, so a poll cannot land on top of the screen a key
   * press just returned.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    // Self-scheduling rather than setInterval, for two reasons. The interval
    // is now a moving target (it backs off), and setInterval would also fire
    // on schedule regardless of whether the PREVIOUS request had returned —
    // stacking overlapping reads on exactly the slow link where that hurts.
    // Scheduling the next poll only after the current one settles cannot.
    const run = async () => {
      if (cancelled) return;
      if (!document.hidden && !pausedRef.current) await refresh();
      if (!cancelled) timer = setTimeout(run, intervalRef.current);
    };
    timer = setTimeout(run, intervalRef.current);

    // Coming back to a backgrounded tab: the screen on display may be minutes
    // old, so reset to the floor and read immediately rather than waiting out
    // whatever backoff was in force when the phone was pocketed.
    const onVisible = () => {
      if (document.hidden) return;
      intervalRef.current = floorRef.current;
      clearTimeout(timer);
      void run();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    const el = paneRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    // Recomputed here as well as on scroll: sticking to the bottom by ASSIGNING
    // scrollTop does fire a scroll event, but output that is shorter than the
    // pane never scrolls at all, so nothing would ever correct the initial
    // value. Reading it on every output change covers both.
    readScroll();
  }, [output]);

  /**
   * The pane's scroll position, reduced to the two facts anything here needs:
   * are we following the tail, and are we at the top.
   *
   * `atTop` uses a generous threshold and no hysteresis, which is safe because
   * showing the button cannot move the scroll position that decides whether to
   * show it: the button occupies layout above the pane, so the pane loses
   * height at its BOTTOM edge while scrollTop and scrollHeight both stay put.
   * There is no feedback loop to oscillate.
   */
  const readScroll = () => {
    const el = paneRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    setAtTop(el.scrollTop <= TOP_THRESHOLD_PX);
  };

  // Reconstructed scrollback, revealed only as far as the operator asked.
  // Nothing of it renders by default: the pane costs exactly what it did
  // before until "show earlier" is tapped, which is what keeps a 2000-line
  // history from becoming 36,000 DOM nodes nobody asked for.
  const history = historyFor(paneId) ?? { settled: [], gaps: 0 };
  const reconstructed = shownHistory > 0
    ? history.settled.slice(Math.max(0, history.settled.length - shownHistory))
    : [];
  // Counted off the RECONSTRUCTED slice even when an override is on screen:
  // "how much reconstruction is still held back" is what the button reports,
  // and it stays the right number the moment a journal pane falls back.
  const remaining = history.settled.length - reconstructed.length;
  const revealed = revealedOverride ?? reconstructed;

  const pinScroll = () => {
    const el = paneRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    return () => requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  };

  const revealMore = () => {
    const restore = pinScroll();
    setShownHistory((n) => n + HISTORY_PAGE);
    restore();
  };

  /**
   * A rejection from a shell send, turned into something an operator can read.
   *
   * A 409 is the pane route's answer for "this pane has an agent now" — a
   * promotion in flight, from a shell someone just typed `claude` into. The
   * READ path already treats that as a transition rather than a failure, and
   * says why: never raise a banner that would put an internal route name in
   * front of the operator. The write path is the same event arriving through a
   * different door, so it gets the same treatment — `stalled`, plus a note in
   * the operator's own words. The detail string it replaces
   * ("use /api/agents/:id/text") was written for a developer calling the API.
   */
  const shellFailure = (err: unknown): string => {
    if (err instanceof RequestFailed && err.status === 409) {
      setStalled(true);
      return "this pane is now an agent";
    }
    return err instanceof Error ? err.message : String(err);
  };

  /**
   * Type a command into the shell AND run it. The pad is disabled for the
   * whole round trip, same as `AgentTerminal.press` — two keys in flight
   * against one shell can land out of order, and a cursor that jumps two rows
   * on one tap is worse than one that responds a beat later.
   *
   * `submit` is passed as `true` because that is what the button says. It is a
   * parameter rather than a constant inside the sender so that the seam a test
   * drives is the same one the route sees: `pane.send_text` does NOT submit,
   * and a test that only asserts "the sender was called" is satisfied by a
   * command left sitting unexecuted on the prompt line — which is exactly what
   * shipped.
   *
   * No `pane.apply(...)` afterwards: `sendText`'s success body is `{ok:
   * true}` alone (see the prop's own note), so there is no screen to push in
   * early. The poll — paused only for the duration of this call, via
   * `pausedRef` above — picks up whatever the command produced on its next
   * tick.
   */
  const submitShellText = async (text: string) => {
    if (!onSendText) return;
    setShellBusy(true);
    setShellFeedback(null);
    try {
      const res = await onSendText(text, true);
      if (res.ok) {
        // The route settles and reads now, so the command's own screen comes
        // back on THIS response. Applying it here is what makes Enter feel
        // immediate; it also resets the poll to its floor (see `apply`), so
        // the output that follows arrives at the fast cadence rather than
        // whatever backoff the idle shell had built up.
        if (res.lines) apply(res.lines, null);
        setShellReply("");
      } else {
        // Surfaced, never swallowed: a command that did not reach the shell
        // must not look like it did (§16.3).
        setShellFeedback({ detail: res.detail ?? "Failed." });
      }
    } catch (err) {
      // `sendPaneText` REJECTS on a refusal — `readJson`'s convention, not
      // the agent-side actions' "always resolves" one (see its own note in
      // `api.ts`) — so a real 404/409/502 arrives here as a throw, not as
      // `res.ok === false`. Caught so it still reaches the operator instead
      // of becoming an unhandled rejection that looks, from their chair,
      // exactly like the command landed.
      //
      // The box is deliberately NOT cleared on a failure, including the
      // half-landed `typed, but not run` one. There the text is already on
      // the prompt line, so what the operator needs is the message saying
      // so — not an empty box that invites retyping a command which would
      // then run twice.
      setShellFeedback({ detail: shellFailure(err) });
    }
    setShellBusy(false);
  };

  const pressShellKey = async (key: NavKey) => {
    if (!onSendKey) return;
    setShellBusy(true);
    setShellFeedback(null);
    try {
      const res = await onSendKey(key);
      // Same round trip as `submitShellText`: the route settled and read, so
      // the key's effect is in hand rather than a poll away. This is what makes
      // ^C feel like an interrupt instead of a request.
      if (res.ok && res.lines) apply(res.lines, null);
      if (!res.ok) setShellFeedback({ detail: res.detail ?? "Key failed." });
    } catch (err) {
      // See `submitShellText`'s note just above: `sendPaneKey` rejects rather
      // than resolving `ok: false`.
      setShellFeedback({ detail: shellFailure(err) });
    }
    setShellBusy(false);
  };

  // parseAnsi carries style ACROSS lines, so it must see history and the live
  // screen as one sequence — parsing them separately would drop any colour a
  // scrolled-off line had opened. Slicing the RESULT is safe; slicing the
  // input would not be.
  const lineSpans = parseAnsi([...revealed, ...output]);
  const blocks = groupLines(lineSpans.map((spans) => spans.map((sp) => sp.text).join("")));

  // `undefined` means the slot declined to decide; `null` means it decided
  // there is nothing to offer. Only the first falls through to the built-in.
  const slot = earlier ? earlier({ remaining, gaps: history.gaps, revealMore, pinScroll }) : undefined;
  const earlierNode = slot !== undefined ? slot : (remaining > 0 && (
    <button type="button" className="term-earlier" onClick={revealMore}>
      Show earlier
      {` · ${remaining} lines`}
      {history.gaps > 0 && <span className="term-gapnote"> · {history.gaps} gaps</span>}
    </button>
  ));

  return (
    <section className="term" aria-label={`${title} terminal`}>
      <header className="term-header">
        {/* Glyph only. `aria-label` already carried the meaning for assistive
            tech, so the word was spending ~55px of a 390px header on something
            only sighted users read — and they read the ‹ just as well. */}
        <button type="button" className="term-back" onClick={onBack} aria-label={backLabel}>
          ‹
        </button>
        <div className="term-title">
          <strong>{title}</strong>
          {headerExtra}
          {/* Shown rather than hidden: a pane that has stopped updating must
              not look current. */}
          {stalled && <span className="term-stalled" role="status">not updating</span>}
        </div>
      </header>

      {/* Offered when there is something to show AND the operator has scrolled
          to the top — which is the moment they have run out of transcript and
          the only moment the button answers a question they are asking. It used
          to render on the strength of "more history exists", so on any
          long-running agent it never went away: a permanent row of chrome above
          a pane whose entire job is showing as many lines as possible.

          Revealing PREPENDS content, which would otherwise shove the screen
          down and lose the operator's place, so the scroll position is pinned
          across the growth (`pinScroll`). A consequence worth stating: pinning
          means one tap leaves you no longer at the top, so the button hides
          itself and you scroll up through what you just loaded to ask for
          more. That is the same shape as every message app's back-scroll, and
          it beats the alternative of holding you at the top while content
          appears under you. */}
      {!error && atTop && earlierNode}

      {error ? (
        <p className="term-error warn" role="alert">Could not load output: {error}</p>
      ) : (
        <div
          ref={paneRef}
          className="term-pane"
          data-wrap={wrap ? "on" : "off"}
          onScroll={readScroll}
          // `--term-font-px` is read by styles.css's `.term-pane` rule. Set
          // as a custom property rather than a `fontSize` style so
          // `.term-exact`'s `font: inherit` picks it up in both wrap modes
          // without a second place to apply it.
          //
          // Written ONLY when the operator has chosen a size. That rule reads
          // `var(--term-font-px, clamp(0.62rem, 2.3vw, 0.78rem))`, so writing
          // the property unconditionally — which is what a numeric default
          // for `fontPx` made this do — means the clamp never applies to
          // anybody and the pane loses roughly a quarter of its columns on a
          // phone. `undefined` leaves the attribute off entirely.
          style={fontPx === null ? undefined : ({ "--term-font-px": `${fontPx}px` } as CSSProperties)}
        >
          {/* Spans, not raw text: the escapes carry the structure. Every span's
              content is a React child, so React escapes it — this is agent
              output, arbitrary untrusted text, and it must never reach
              innerHTML.

              In Exact mode the whole pane is one `pre` block and the newline is
              emitted explicitly, so a blank line still occupies a row.

              In Wrap mode the buffer is split into runs (`web/lines.ts`):
              prose reflows to the viewport, and each run of structure becomes
              its OWN horizontally scrollable strip. That is what keeps a table
              readable without dragging the surrounding sentences sideways with
              it. */}
          {wrap
            ? blocks.map((b) => (
                <div key={b.from} className={`term-${b.kind}`}>
                  {lineSpans.slice(b.from, b.to + 1).map((spans, i) => (
                    <Fragment key={i}>
                      {spans.map((sp, j) => (
                        <span key={j} style={styleFor(sp)}>{sp.text}</span>
                      ))}
                      {"\n"}
                    </Fragment>
                  ))}
                </div>
              ))
            : (
              <pre className="term-exact">
                {lineSpans.map((spans, i) => (
                  <Fragment key={i}>
                    {spans.map((sp, j) => (
                      <span key={j} style={styleFor(sp)}>{sp.text}</span>
                    ))}
                    {"\n"}
                  </Fragment>
                ))}
              </pre>
            )}
        </div>
      )}

      {/* What became of a spawn asked for from the create sheet, on the pane
          it was asked for (§9.2). Mounted HERE, once, rather than in either
          branch of `App.tsx`: this component renders the shell view directly
          and the agent view through `AgentTerminal`, and a failed start leaves
          a shell while a successful one leaves an agent — so putting it in the
          caller would need two copies and would still have to know which of
          the two it was looking at. Renders nothing unless a launch belongs to
          THIS pane. */}
      <LaunchNotice paneId={paneId} />

      {beforeControls}

      {/* The view controls live HERE, not in the header. In the header they
          competed with the pane's name for a 390px row that also carries a
          back link and a state pill — and the name is the only flexible item,
          so the name lost: it rendered as `sche…`, which is the one thing a
          header exists to tell you. Down here they are also next to the keypad
          that `Keys` collapses, which is where a control for a thing belongs. */}
      <div className="term-controls" role="group" aria-label="View">
        <button
          type="button"
          className="term-wrap-toggle"
          aria-pressed={wrap}
          onClick={() => { const v = !wrap; setWrap(v); writePref("wrap", v); }}
        >
          {wrap ? "Wrap" : "Exact"}
        </button>
        {controls}
        {/* The shell's own pad collapse, present only when this pane is being
            driven as a shell (`onSendKey` supplied). The SAME control
            `AgentTerminal` renders — one `KeypadToggle`, not a second copy of
            its markup and cycle — so the reasoning behind it has one home
            instead of living in one file and being referred to from the
            other. */}
        {onSendKey && <KeypadToggle pad={shellKeypad} onChange={setShellKeypad} />}
        <button type="button" onClick={() => void open()} disabled={paused || shellBusy} aria-label="Refresh">
          ↻
        </button>
      </div>

      {afterControls}

      {/* The shell's own controls (§16.3): no prompt to parse and so no
          option buttons, unlike `AgentTerminal`'s `beforeControls` — a shell
          gets only the keypad and the reply box, both wired to the pane
          route (`pane.send_keys` / `pane.send_text`) instead of the agent
          one. Rendered only when the caller supplied a sender, which is how
          `App.tsx` tells a shell pane from an agent pane here. */}
      {onSendText && (
        <>
          {/* Failures only — see `shellFeedback`'s own note. `.warn` is a
              colour ON TOP of text that already says what happened, never the
              only channel. */}
          {shellFeedback && (
            <p className="term-note warn" role="status">{shellFeedback.detail}</p>
          )}

          {onSendKey && (
            <Keypad pad={shellKeypad} busy={shellBusy} onPress={(k) => void pressShellKey(k)} />
          )}

          <form
            className="term-reply"
            onSubmit={(e) => {
              e.preventDefault();
              // Sent verbatim: this is typing at a shell, not composing a
              // reply to a question, so there is nothing here to trim or
              // reshape beyond leaving an all-whitespace box un-submittable.
              // The newline is NOT appended here — `submit` on the route sends
              // a real `enter` key, which is what a shell's line editor is
              // waiting for, and it keeps the text the operator typed the text
              // that gets stored in their shell history.
              if (shellReply.trim()) void submitShellText(shellReply);
            }}
          >
            <label className="sr-only" htmlFor="term-reply-input">Type a command</label>
            <Input
              id="term-reply-input"
              value={shellReply}
              disabled={shellBusy}
              onChange={(e) => setShellReply(e.target.value)}
              placeholder="Type a command…"
            />
            <Button type="submit" disabled={shellBusy || !shellReply.trim()}>Send</Button>
          </form>
        </>
      )}
    </section>
  );
}
