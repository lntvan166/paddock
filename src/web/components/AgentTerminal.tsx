import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ActionResult, Agent, NavKey, OutputResult, ParsedPrompt } from "@shared/types";
import { answerWithKey, fetchOutput, fetchPrompt, sendKey, sendText } from "@web/api";
import { parseAnsi, type AnsiSpan } from "@web/ansi";
import { groupLines } from "@web/lines";
import { mergeSnapshot } from "@web/history";
import { historyFor, rememberHistory, rememberScreen, screenFor } from "@web/pane-cache";
import { applyPatch, digestOf } from "@shared/screen";
import { RATE_MS, readPrefs, writePref, type RatePref } from "@web/prefs";

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
 * by `@web/prefs` (key `paddock.term.wrap`, kept verbatim from this file's own
 * former constant so no operator's setting resets) — this component reads and
 * writes through it rather than touching `localStorage` directly.
 */

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

/** Settled lines revealed per tap of "show earlier". */
const HISTORY_PAGE = 200;

export interface AgentTerminalProps {
  agent: Agent;
  onBack: () => void;
}

export function AgentTerminal({ agent, onBack }: AgentTerminalProps) {
  // Seeded from the cache, so a re-opened agent has its screen on the first
  // render rather than after a round trip.
  const [output, setOutput] = useState<string[]>(() => screenFor(agent.agentId)?.lines ?? []);
  // Digest of the screen currently held, sent with each poll so the server can
  // answer "unchanged" instead of resending ~10 KB the client already has.
  const digestRef = useRef<string | null>(screenFor(agent.agentId)?.digest ?? null);
  const [error, setError] = useState<string | null>(null);
  // A poll that failed while output is already on screen. Distinct from
  // `error`, which means the read failed with nothing to show.
  const [stalled, setStalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wrap, setWrap] = useState(() => readPrefs().wrap);
  // Read once: Settings is a separate full-screen view (App.tsx unmounts this
  // component to show it), so there is no live pref change to react to while
  // a pane stays open.
  const [fontPx] = useState(() => readPrefs().fontPx);
  const [shownHistory, setShownHistory] = useState(0);
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null);
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

  // The floor the backoff snaps back to, from the operator's refresh preset.
  // A ref for the same reason as `intervalRef` below: read once (see the
  // `fontPx` comment above for why once is enough), and read by callbacks
  // that must not be rebuilt every render to pick up a value that cannot
  // change under them anyway.
  const floorRef = useRef(floorFor(readPrefs().rate));

  // Current backoff position. A ref, not state: changing it must not re-render
  // the pane, and the polling loop has to read the latest value without being
  // rebuilt around it.
  const intervalRef = useRef(floorRef.current);


  const apply = useCallback((lines: string[], digest: string | null = null) => {
    digestRef.current = digest;
    rememberScreen(agent.agentId, { lines, digest });
    // Every live screen is folded into the reconstructed scrollback. Only
    // lines that have provably left the viewport are committed — see
    // `web/history.ts`, which is what stops a redrawn spinner being pasted
    // into history on every poll.
    rememberHistory(
      agent.agentId,
      mergeSnapshot(historyFor(agent.agentId) ?? { settled: [], gaps: 0 }, lines),
    );
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
  /**
   * Returns false when a patch could not be verified, which tells the caller
   * to fetch a whole screen. Reported rather than thrown: a failed patch is a
   * recoverable transport hiccup, not an error worth showing the operator.
   */
  const applyResult = useCallback((res: OutputResult): boolean => {
    if (res.unchanged) {
      // Nothing moved: wait longer before asking again.
      intervalRef.current = nextRefreshMs(intervalRef.current, false);
      setStalled(false);
      return true;
    }
    // The screen moved, so it may well move again — follow it closely.
    intervalRef.current = nextRefreshMs(intervalRef.current, true, floorRef.current);

    if ("patch" in res) {
      const base = screenFor(agent.agentId)?.lines ?? [];
      const next = applyPatch(base, res.patch);
      // Self-check. The server states the digest the patch should produce, so
      // a patch applied against the wrong base — or a bug in either half —
      // is caught here instead of showing output that never existed.
      if (digestOf(next) !== res.patch.digest) return false;
      apply(next, res.patch.digest);
      return true;
    }

    apply(res.lines, res.digest);
    return true;
  }, [agent.agentId, apply]);

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
      const ok = applyResult(await fetchOutput(agent.agentId, undefined, false, digestRef.current));
      // A patch that failed its self-check: ask for a whole screen, without a
      // digest so the server cannot answer with another patch.
      if (!ok) applyResult(await fetchOutput(agent.agentId));
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
   * The prompt, fetched only while the agent is actually blocked.
   *
   * Cleared the moment it is not: an option list left on screen after the
   * agent moved on would offer buttons that answer a question nobody is
   * asking any more, and `/answer` would refuse them with a 409 anyway.
   */
  useEffect(() => {
    if (agent.state !== "blocked") { setPrompt(null); return; }
    let live = true;
    void fetchPrompt(agent.agentId)
      .then((p) => { if (live) setPrompt(p); })
      .catch(() => { if (live) setPrompt(null); });
    return () => { live = false; };
  }, [agent.agentId, agent.state]);

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
      // The cursor has moved, so the preview must move with it.
      if (res.selected !== undefined) {
        setPrompt((p) => (p ? { ...p, selected: res.selected ?? null } : p));
      }
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
  // Reconstructed scrollback, revealed only as far as the operator asked.
  // Nothing of it renders by default: the pane costs exactly what it did
  // before until "show earlier" is tapped, which is what keeps a 2000-line
  // history from becoming 36,000 DOM nodes nobody asked for.
  const history = historyFor(agent.agentId) ?? { settled: [], gaps: 0 };
  const revealed = shownHistory > 0
    ? history.settled.slice(Math.max(0, history.settled.length - shownHistory))
    : [];

  // parseAnsi carries style ACROSS lines, so it must see history and the live
  // screen as one sequence — parsing them separately would drop any colour a
  // scrolled-off line had opened.
  const lineSpans = parseAnsi([...revealed, ...output]);
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
          onClick={() => { const v = !wrap; setWrap(v); writePref("wrap", v); }}
        >
          {wrap ? "Wrap" : "Exact"}
        </button>
        <button type="button" onClick={() => void load()} disabled={busy} aria-label="Refresh">
          ↻
        </button>
      </header>

      {/* Only offered when there is something to show. Revealing PREPENDS
          content, which would otherwise shove the screen down and lose the
          operator's place, so the scroll position is pinned across the growth
          in the handler below. */}
      {!error && history.settled.length > revealed.length && (
        <button
          type="button"
          className="term-earlier"
          onClick={() => {
            const el = paneRef.current;
            const before = el ? el.scrollHeight - el.scrollTop : 0;
            setShownHistory((n) => n + HISTORY_PAGE);
            requestAnimationFrame(() => {
              if (el) el.scrollTop = el.scrollHeight - before;
            });
          }}
        >
          Show earlier · {history.settled.length - revealed.length} lines
          {history.gaps > 0 && <span className="term-gapnote"> · {history.gaps} gaps</span>}
        </button>
      )}

      {error ? (
        <p className="term-error warn" role="alert">Could not load output: {error}</p>
      ) : (
        <div
          ref={paneRef}
          className="term-pane"
          data-wrap={wrap ? "on" : "off"}
          onScroll={rememberScroll}
          // `--term-font-px` is read by styles.css:249. Set as a custom
          // property rather than a `fontSize` style so `.term-exact`'s
          // `font: inherit` (styles.css:399) picks it up in both wrap modes
          // without a second place to apply it.
          style={{ "--term-font-px": `${fontPx}px` } as CSSProperties}
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

      {feedback && (
        <p className={feedback.ok ? "term-note ok" : "term-note warn"} role="status">
          {feedback.ok ? "Sent." : (feedback.detail ?? "Failed.")}
        </p>
      )}

      {/* Real option buttons, but ONLY when the parser was confident. Each
          carries the agent's own label verbatim — no reordering, no
          summarising, no generic "Approve" — so committing one cannot be off
          by one the way arrowing to it can. When the parser refuses (it does,
          on prompts whose options are separated by description lines) there
          are simply no buttons, and the keypad below is the floor. */}
      {prompt?.options && prompt.options.length > 0 && (
        <div className="term-options" role="group" aria-label="Answer">
          {prompt.question && <p className="term-question">{prompt.question}</p>}
          {prompt.options.map((o) => (
            <button
              key={o.key}
              type="button"
              className="term-option"
              disabled={busy}
              aria-pressed={o.selected}
              onClick={() => {
                setBusy(true);
                void answerWithKey(agent.agentId, o.key)
                  .then((r) => setFeedback(r))
                  .finally(() => setBusy(false));
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {/* What Enter would commit, right where the thumb is.

          The keypad's ↓ wraps from the last option back to the first, and the
          middle option of a permission prompt is routinely a persistent grant
          ("and don't ask again"). The wrap was never really the hazard — the
          wrap being INVISIBLE was. This is shown whenever a cursor exists, so
          it covers the prompt shapes the option parser refuses to read, which
          are exactly the ones where the keypad is the only way to answer. */}
      {prompt?.selected && (
        <p className="term-selected" role="status">
          <span className="term-selected-label">⏎ Enter selects</span>
          {prompt.selected}
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
