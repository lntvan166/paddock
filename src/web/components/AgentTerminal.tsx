import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ActionResult, Agent, NavKey, OutputResult } from "@shared/types";
import { fetchOutput, sendKey, sendText } from "@web/api";
import { parseAnsi, type AnsiSpan } from "@web/ansi";
import { groupLines } from "@web/lines";

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
 * The keypad, laid out as it is rendered.
 *
 * Only keys herdr accepts appear (verified against herdr 0.8.0 — `pageup`,
 * `home` and friends are rejected with `invalid_key`, so offering them would
 * be a button that always fails). The order puts ↑/↓/Enter where a thumb
 * reaches them, because moving a selection and committing it is the whole
 * reason this pad exists.
 */
const PRIMARY_KEYS: ReadonlyArray<{ key: NavKey; label: string }> = [
  { key: "up", label: "↑" },
  { key: "down", label: "↓" },
  { key: "enter", label: "⏎ Enter" },
];

/**
 * Everything else, on a shorter row.
 *
 * The split is by frequency, not by category: answering a prompt from a phone
 * is ↑/↓ to move and Enter to commit, and those three had been sharing equal
 * billing with Space and Tab across three tall rows that took 40% of the
 * viewport — on the screen whose whole job is showing a transcript.
 */
const SECONDARY_KEYS: ReadonlyArray<{ key: NavKey; label: string }> = [
  { key: "esc", label: "Esc" },
  { key: "left", label: "←" },
  { key: "right", label: "→" },
  { key: "tab", label: "Tab" },
  // Spelled out, not "␣": the symbol renders as a tofu box in several mobile
  // system fonts, which is a button whose label is a rendering failure.
  { key: "space", label: "Space" },
];

const WRAP_KEY = "paddock.term.wrap";

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
 * So the operator decides, per pane, at any moment. Wrapping is the DEFAULT
 * because reading is the common case, and a folded table is recoverable with
 * one tap whereas scrolling every prose line is a permanent tax.
 */
function readWrap(): boolean {
  try {
    const v = localStorage.getItem(WRAP_KEY);
    return v === null ? true : v === "1";
  } catch {
    // Safari private mode throws on write, and a blocked-storage policy can
    // throw on mere access — and this runs during render. Fail to the default
    // rather than taking the dashboard down. See web/install.ts.
    return true;
  }
}

function saveWrap(on: boolean): void {
  try {
    localStorage.setItem(WRAP_KEY, on ? "1" : "0");
  } catch {
    // Best-effort; the setting just does not survive the session.
  }
}

/** Distance from the bottom, in px, still counted as "following the tail". */
const STICK_THRESHOLD_PX = 48;

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
 * The next poll delay, given the current one and whether the screen moved.
 *
 * Pure and exported so the ladder is testable without a live agent and
 * without a DOM — the component holds it in a ref, which no unit test can
 * reach.
 */
export function nextRefreshMs(current: number, changed: boolean): number {
  if (changed) return MIN_REFRESH_MS;
  return Math.min(MAX_REFRESH_MS, Math.round(current * REFRESH_BACKOFF));
}

/**
 * Last screen seen per agent, kept for the life of the page.
 *
 * Re-opening an agent paints instantly from here instead of showing an empty
 * pane while a request is in flight. Over a local socket that gap is one
 * frame; over a phone on a ~250 ms link it is the entire impression of
 * slowness, and a blank pane is also indistinguishable from "this agent has
 * no output".
 *
 * Deliberately module-level rather than in the store: it is a render cache,
 * not agent state, and putting it in the store would push it through the
 * delta path to every connected browser for no benefit.
 *
 * Unbounded is fine — one screen per agent the operator has actually opened,
 * bounded in practice by the agent list itself.
 */
const screenCache = new Map<string, { lines: string[]; digest: string | null }>();

export interface AgentTerminalProps {
  agent: Agent;
  onBack: () => void;
}

export function AgentTerminal({ agent, onBack }: AgentTerminalProps) {
  // Seeded from the cache, so a re-opened agent has its screen on the first
  // render rather than after a round trip.
  const [output, setOutput] = useState<string[]>(() => screenCache.get(agent.agentId)?.lines ?? []);
  // Digest of the screen currently held, sent with each poll so the server can
  // answer "unchanged" instead of resending ~10 KB the client already has.
  const digestRef = useRef<string | null>(screenCache.get(agent.agentId)?.digest ?? null);
  const [error, setError] = useState<string | null>(null);
  // A poll that failed while output is already on screen. Distinct from
  // `error`, which means the read failed with nothing to show.
  const [stalled, setStalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wrap, setWrap] = useState(readWrap);
  const [reply, setReply] = useState("");
  const [feedback, setFeedback] = useState<ActionResult | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  // Whether the operator is following the tail. Read BEFORE the DOM updates
  // and applied after, so replacing the screen does not yank someone who has
  // deliberately scrolled up to read earlier output.
  const stick = useRef(true);

  // Mirrors `busy` for the polling interval, which must read the CURRENT value
  // without being torn down and rebuilt every time a key press flips it.
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  // Current backoff position. A ref, not state: changing it must not re-render
  // the pane, and the polling loop has to read the latest value without being
  // rebuilt around it.
  const intervalRef = useRef(MIN_REFRESH_MS);


  const apply = useCallback((lines: string[], digest: string | null = null) => {
    digestRef.current = digest;
    screenCache.set(agent.agentId, { lines, digest });
    setOutput(lines);
    setError(null);
    setStalled(false);
  }, [agent.agentId]);

  /**
   * Applies a read that may be a "nothing changed" answer.
   *
   * `unchanged` must NOT fall through to `apply([])` — that would blank the
   * pane on precisely the responses that mean it is still correct. It clears
   * `stalled` though: a successful revalidation is proof the link is alive.
   */
  const applyResult = useCallback((res: OutputResult) => {
    if (res.unchanged) {
      // Nothing moved: wait longer before asking again.
      intervalRef.current = nextRefreshMs(intervalRef.current, false);
      setStalled(false);
      return;
    }
    // The screen moved, so it may well move again — follow it closely.
    intervalRef.current = nextRefreshMs(intervalRef.current, true);
    apply(res.lines, res.digest);
  }, [apply]);

  /**
   * The cheap re-read used by the poll: `visible` only, never scrollback.
   *
   * A failed poll does NOT clear the screen and does NOT raise the error
   * banner — the last good output is still the best thing to show. It is not
   * swallowed either: `stalled` puts a marker in the header, so a pane that
   * has quietly stopped updating says so rather than looking current.
   */
  const refresh = useCallback(async () => {
    try {
      applyResult(await fetchOutput(agent.agentId, undefined, false, digestRef.current));
    } catch {
      setStalled(true);
    }
  }, [agent.agentId, applyResult]);

  /**
   * The opening read. `visible` only — the live viewport, which is exactly
   * what the terminal shows.
   *
   * This used to make a SECOND, scrollback read for `idle` agents to add
   * history. That was removed, because the poll asks for `visible` and the two
   * sources return different content: the digest could never match, and
   * suppressing the poll to avoid the pane oscillating left it frozen. The
   * justification given at the time — "an idle agent by definition is not
   * producing output" — is simply false. `idle` means READY FOR INPUT, and a
   * pane changes whenever anyone types at the desk. An operator watching a
   * frozen screen has no way to tell it from a quiet one.
   *
   * History on demand is worth having back as an explicit control; see
   * `docs/roadmap.md`. It is not worth having as a hidden second request that
   * fights the refresh loop.
   */
  const load = useCallback(async () => {
    try {
      // No `since` on the opening read: the point is to paint, and a cached
      // screen from a previous visit may be minutes stale even when its
      // digest still matches whatever it matched then.
      applyResult(await fetchOutput(agent.agentId));
    } catch (err) {
      // Surfaced where the output would have been. A blank pane that means
      // "the read failed" is indistinguishable from one that means "no
      // output", and this project treats a silent break as the defect.
      setError(String(err instanceof Error ? err.message : err));
    }
  }, [agent.agentId, applyResult]);

  // Refetch on open and whenever the agent's state changes: a transcript
  // frozen at the moment the view opened is the thing an operator is most
  // likely to misread as current.
  useEffect(() => {
    void load();
  }, [load, agent.state]);

  /**
   * Keep the open pane live.
   *
   * Spec §5's "never streamed" rule is about pushing SEVERAL terminals
   * continuously down a ~250 ms link — the thing named as the one way to make
   * paddock genuinely slow. This is one pane, only while its screen is open,
   * from the `visible` source that costs ~2 ms. Without it a working agent's
   * transcript is frozen at the moment the view opened, which is worse than
   * slow: it is confidently wrong, and indistinguishable from an agent that
   * has stopped.
   *
   * Paused when the document is hidden — a phone with the browser backgrounded
   * must not poll a tunnel every few seconds for a screen nobody is looking at.
   * Skipped while `busy`, so a poll cannot land on top of the screen a key
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
      if (!document.hidden && !busyRef.current) await refresh();
      if (!cancelled) timer = setTimeout(run, intervalRef.current);
    };
    timer = setTimeout(run, intervalRef.current);

    // Coming back to a backgrounded tab: the screen on display may be minutes
    // old, so reset to the floor and read immediately rather than waiting out
    // whatever backoff was in force when the phone was pocketed.
    const onVisible = () => {
      if (document.hidden) return;
      intervalRef.current = MIN_REFRESH_MS;
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
  }, [output]);

  const rememberScroll = () => {
    const el = paneRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  /**
   * The pad is disabled for the whole round trip rather than queueing presses.
   * Two keys in flight against one TUI can land out of order, and a cursor
   * that jumps two rows on one tap is worse than one that responds a beat
   * later — especially when the next tap is Enter.
   */
  const press = async (key: NavKey) => {
    setBusy(true);
    setFeedback(null);
    const res = await sendKey(agent.agentId, key);
    // `lines` is empty on failure, which is "no new screen" and NOT "the pane
    // is empty" — replacing the output with it would blank the terminal on a
    // key that simply did not go through.
    if (res.ok) {
      apply(res.lines);
    } else {
      setFeedback({ ok: false, detail: res.detail ?? "Key failed." });
    }
    setBusy(false);
  };

  const submitReply = async (text: string) => {
    setBusy(true);
    // `sendText`, NOT `answerWithText`. The latter answers a prompt and is
    // refused with a 409 the moment the agent stops being blocked — which is
    // three states out of four, and was why this box always failed.
    const res = await sendText(agent.agentId, text);
    if (res.ok) {
      setReply("");
      apply(res.lines);
      setFeedback(null);
    } else {
      setFeedback({ ok: false, detail: res.detail ?? "Failed." });
    }
    setBusy(false);
  };

  // Parsed once per render and shared by both modes. `parseAnsi` carries style
  // ACROSS lines, so it must see the whole buffer in order — slicing the
  // result is safe, slicing the input would not be.
  const lineSpans = parseAnsi(output);
  const blocks = groupLines(lineSpans.map((spans) => spans.map((sp) => sp.text).join("")));

  return (
    <section className="term" aria-label={`${agent.name} terminal`}>
      <header className="term-header">
        <button type="button" className="term-back" onClick={onBack} aria-label="Back to agents">
          ‹ Agents
        </button>
        <div className="term-title">
          <strong>{agent.name}</strong>
          <span className="term-state" data-state={agent.state}>{agent.state}</span>
          {/* Shown rather than hidden: a pane that has stopped updating must
              not look current. */}
          {stalled && <span className="term-stalled" role="status">not updating</span>}
        </div>
        <button
          type="button"
          className="term-wrap-toggle"
          aria-pressed={wrap}
          onClick={() => { const v = !wrap; setWrap(v); saveWrap(v); }}
        >
          {wrap ? "Wrap" : "Exact"}
        </button>
        <button type="button" onClick={() => void load()} disabled={busy} aria-label="Refresh">
          ↻
        </button>
      </header>

      {error ? (
        <p className="term-error warn" role="alert">Could not load output: {error}</p>
      ) : (
        <div ref={paneRef} className="term-pane" data-wrap={wrap ? "on" : "off"} onScroll={rememberScroll}>
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

      {feedback && (
        <p className={feedback.ok ? "term-note ok" : "term-note warn"} role="status">
          {feedback.ok ? "Sent." : (feedback.detail ?? "Failed.")}
        </p>
      )}

      {/* Always present, in every state. These keys move the agent's own
          cursor on a screen the operator can see; they assert nothing about
          what an option means, which is why they work on prompt shapes the
          parser cannot read. A pad that appeared and vanished as the agent's
          state changed would move under the operator's thumb. */}
      <div className="term-keys" role="group" aria-label="Send key">
        <div className="term-keys-primary">
          {PRIMARY_KEYS.map((k) => (
            <button
              key={k.key} type="button" className="term-key"
              disabled={busy} onClick={() => void press(k.key)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="term-keys-secondary">
          {SECONDARY_KEYS.map((k) => (
            <button
              key={k.key} type="button" className="term-key term-key-sm"
              disabled={busy} onClick={() => void press(k.key)}
              aria-label={k.key}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      <form
        className="term-reply"
        onSubmit={(e) => {
          e.preventDefault();
          if (reply.trim()) void submitReply(reply.trim());
        }}
      >
        <label className="sr-only" htmlFor="term-reply-input">Reply</label>
        <input
          id="term-reply-input"
          value={reply}
          disabled={busy}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Type a reply…"
        />
        <button type="submit" disabled={busy || !reply.trim()}>Send</button>
      </form>
    </section>
  );
}
