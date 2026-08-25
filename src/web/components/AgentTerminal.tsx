import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult, Agent, NavKey, ParsedPrompt } from "@shared/types";
import { answerWithKey, fetchHistory, fetchOutput, fetchPrompt, sendKey, sendText } from "@web/api";
import { StatusDot } from "@web/components/AgentRow";
import { StateIcon } from "@web/components/ui/StateIcon";
import { Button } from "@web/components/shadcn/button";
import { Input } from "@web/components/shadcn/input";
import { PaneTerminal, type EarlierContext, type PaneTerminalHandle } from "@web/components/PaneTerminal";
import {
  emptyJournal, journalFor, updateJournal, type JournalState,
} from "@web/pane-cache";
import { readPrefs, writePref, type KeypadPref } from "@web/prefs";

/**
 * An agent's controls, wrapped around the pane transcript every pane has.
 *
 * The transcript, the ANSI pass, the scroll handling and the read loop live in
 * `PaneTerminal` — they work for any pane, with or without an agent, because a
 * shell and an agent are ONE PANE AT TWO MOMENTS: open a shell, type `claude`,
 * and the same `pane_id` becomes an agent. What is left here is everything
 * that needs an agent to point at: the prompt and its options, the keypad, the
 * state dot, the reply box, and the journal that only a harness has.
 *
 * The refresh ladder's constants are re-exported below rather than moved,
 * because they were exported from this module before the split and other
 * callers (and tests) import them from here.
 */
export {
  MIN_REFRESH_MS, MAX_REFRESH_MS, floorFor, nextRefreshMs,
} from "@web/components/PaneTerminal";

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
 * Earlier turns fetched per tap of "show earlier" for an agent with a
 * journal — `fetchHistory`'s `limit`.
 *
 * Counted in TURNS, not lines — deliberately its own constant rather than
 * reusing `HISTORY_PAGE`, which counts LINES for the reconstructed-scrollback
 * path. A single assistant turn routinely flattens to several lines, so a page
 * size chosen the way `HISTORY_PAGE` was (as a count of lines) would ask for
 * far more prose than it looks like: 50 turns lands 250+ lines in one tap — a
 * wall dumped on a phone screen, not the thumb-flick "show earlier" is meant
 * to be. 20 keeps one tap's growth in the same ballpark as what the
 * reconstructed path already reveals.
 */
const JOURNAL_PAGE_TURNS = 20;

export interface AgentTerminalProps {
  agent: Agent;
  onBack: () => void;
}

export function AgentTerminal({ agent, onBack }: AgentTerminalProps) {
  const [busy, setBusy] = useState(false);
  /**
   * Which half of the pad is on screen, seeded from the stored preference.
   *
   * Held here as well as in storage because a blocked agent may open it (see
   * the effect below) WITHOUT that counting as the operator's choice — writing
   * the pref there would quietly discard a deliberate "compact" the first time
   * an agent asked a question.
   */
  const [keypad, setKeypad] = useState<KeypadPref>(() => readPrefs().keypad);
  /**
   * Journal-sourced lines, the cursor for the next page, and this pane's two
   * latched answers — all of it read from and written back to `pane-cache`.
   *
   * IN THE CACHE, NOT IN THIS COMPONENT, and that is the whole point of
   * `pane-cache` existing: this component is remounted per agent and on every
   * navigation, so four `useState`s here meant six taps of history — six round
   * trips — vanishing the moment the operator went back to the list and
   * reopened the pane. The reconstructed path this replaces keeps its
   * scrollback across exactly that journey. The `useState` below is a MIRROR
   * that makes React re-render; every write goes through `updateJournal`, so
   * the cache stays the single source of truth and `prunePanes` evicts this
   * alongside the screen and scrollback when the agent is gone.
   *
   * Kept separate from the reconstructed path because the two sources never mix
   * for one agent (design decision 18) — this is WHICH ONE is in play, not
   * something merged with the reconstructed path.
   *
   * `done` is "no more JOURNAL pages", set only on a genuine `hasMore: false`
   * from a `source: "journal"` response — distinct from `fellBack`:
   *
   * `agent.hasJournal` is a HINT that this pane is worth trying — it is a
   * property of the harness, decided once at reconcile time. `source` on
   * each `/history` response is the ANSWER for this pane, decided per
   * request: the session ref can be missing, the file can be gone or
   * unreadable, even though the harness itself has a journal adapter (see
   * decision 18's "quiet in the UI, loud on the host" cases). Rendering off
   * the hint alone stranded the operator on a pane whose every response came
   * back `source: "reconstruction", lines: []` — `done` latched true and
   * `revealed` stayed pinned to the empty `lines` forever, with the
   * reconstructed scrollback never read. `fellBack` flips permanently
   * false→true the first time a response says so, and once it does this pane
   * behaves EXACTLY like a journal-less one from then on — the two sources
   * still never coexist, decided here instead of from the static prop.
   */
  const [journal, setJournal] = useState<JournalState>(
    () => journalFor(agent.agentId) ?? emptyJournal(),
  );
  const patchJournal = useCallback(
    (patch: (prev: JournalState) => JournalState) => {
      setJournal(updateJournal(agent.agentId, patch));
    },
    [agent.agentId],
  );
  // Guards the in-flight `/history` request against a double-tap on the
  // button re-firing it with the same (not yet advanced) cursor. A REF, not
  // just the `journalBusy` state below: two synchronous `click()`s land
  // before React re-renders to reflect a state update, so only a ref read
  // synchronously inside the handler can see the first click's effect
  // before the second one runs.
  const journalBusyRef = useRef(false);
  // Mirrors the ref, so the button can be visually `disabled` while a
  // request is in flight — the ref alone has no way to trigger a re-render.
  const [journalBusy, setJournalBusy] = useState(false);
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null);
  /**
   * How many real option buttons this screen will render.
   *
   * Derived here, above the auto-reveal effect below, because that effect needs
   * it in its dependency array and a dependency has to exist at render time.
   * Zero means the parser refused, which is exactly when the key pad is the
   * only way to answer.
   */
  const promptOptionCount = prompt?.options?.length ?? 0;
  /** Whether the `/prompt` fetch below has settled — see its own note. */
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [reply, setReply] = useState("");
  const [feedback, setFeedback] = useState<ActionResult | null>(null);
  /** The transcript, so a key press can push the screen it just produced. */
  const pane = useRef<PaneTerminalHandle>(null);

  /**
   * A blocked agent may OPEN a collapsed pad. It may never close one.
   *
   * The asymmetry is the whole design: revealing a key the operator is about to
   * want costs them nothing, while removing one mid-tap is exactly the hazard
   * that keeps the primary row present in every state. So this only ever moves
   * toward "full", and only while the operator has left the behaviour switched
   * on. The stored preference is deliberately not written — this is the agent's
   * doing, not a choice, and it must not survive as one.
   */
  useEffect(() => {
    if (agent.state !== "blocked") return;
    if (!readPrefs().keypadAuto) return;
    // Only when the pad is the ONLY way in. A parsed prompt renders real option
    // buttons, and tapping one sends the agent's own digit in a single tap —
    // `answerWithKey` below, and the note there on why that cannot be off by
    // one the way arrowing to it can. Forcing 106px of arrows onto that screen
    // buys nothing; `Keys` is one tap away for Esc or Tab.
    //
    // Still expand-only. This declines to OPEN the pad; it never closes one, so
    // a prompt that becomes parseable while the operator is reaching for Esc
    // leaves the pad exactly where their thumb expects it.
    // Wait until the prompt is actually known. On mount it is null because
    // nothing has been fetched yet, which is indistinguishable from "the parser
    // refused" without this flag.
    if (!promptLoaded) return;
    if (promptOptionCount > 0) return;
    setKeypad("full");
  }, [agent.state, promptOptionCount, promptLoaded]);

  /**
   * The agent's read, handed to the transcript.
   *
   * `agent.state` is in the dependency list on purpose even though the body
   * never reads it: `PaneTerminal` re-reads whenever `load` changes identity,
   * and a transcript frozen at the moment the view opened is the thing an
   * operator is most likely to misread as current.
   */
  const load = useCallback(
    (since: string | null) => fetchOutput(agent.agentId, undefined, false, since),
    [agent.agentId, agent.state],
  );

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
    setPromptLoaded(false);
    void fetchPrompt(agent.agentId)
      // Settled either way, success or failure: "the parser refused" and "we
      // have not asked yet" are both `prompt === null`, and the pad's
      // auto-reveal has to tell them apart. Without this it fired on mount
      // while the fetch was still in flight, saw no options, and opened the pad
      // on every blocked agent — including the ones whose options arrived a
      // beat later, which is the case it exists to leave alone.
      .then((p) => { if (live) { setPrompt(p); setPromptLoaded(true); } })
      .catch(() => { if (live) { setPrompt(null); setPromptLoaded(true); } });
    return () => { live = false; };
  }, [agent.agentId, agent.state]);

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
      pane.current?.apply(res.lines);
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
      pane.current?.apply(res.lines);
      setFeedback(null);
    } else {
      setFeedback({ ok: false, detail: res.detail ?? "Failed." });
    }
    setBusy(false);
  };

  // Design decision 18: the two sources never coexist for one agent, but
  // which one is "in play" is decided by what the SERVER has answered for
  // this pane (`journal.fellBack`), not by the static `hasJournal` hint —
  // see the comment on `journal` above for why that distinction is
  // load-bearing. Once a pane has fallen back, it reveals reconstructed
  // history exactly like a journal-less agent always has.
  const useJournal = agent.hasJournal && !journal.fellBack;

  /**
   * Whether the cursor is on this option, judged by `prompt.selected` and NOT
   * by the option's own `selected` flag.
   *
   * `options` is fetched once per blocked agent (the `/prompt` effect keys on
   * `agentId` and `state`), while `press()` patches only `selected` from the
   * screen `/key` just re-read. So the per-option flag is frozen at whatever
   * was true when the pane opened; `selected` is the only field that follows
   * the cursor.
   *
   * Reading the frozen flag shipped a real regression: after any arrow tap the
   * accent border stayed on the option the cursor had left, and the dedupe
   * guard below — testing that same flag — kept the preview hidden. One wrong
   * signal and no right ones, in the mechanism whose whole purpose is stopping
   * the operator arrowing one step too far into a persistent grant.
   *
   * `parsePrompt` builds `selected` as `${key}. ${label}` deliberately so it is
   * comparable here; see its own note on why that string is rebuilt rather than
   * reused from the matched line.
   */
  const isSelected = (o: { key: string; label: string }) =>
    `${o.key}. ${o.label}` === prompt?.selected;

  /**
   * "Show earlier", for the agents that have a journal.
   *
   * `undefined` hands the decision back to the transcript's own reconstructed
   * button, which is exactly what a journal-less agent — and a pane that has
   * fallen back — must get. `null` is the other outcome and a different claim:
   * the journal has genuinely run out, so nothing is offered even though
   * reconstructed lines exist behind it.
   */
  const earlier = (ctx: EarlierContext) => {
    if (!useJournal) return undefined;
    if (journal.done) return null;
    return (
      <button
        type="button"
        className="term-earlier"
        disabled={journalBusy}
        onClick={() => {
          const restore = ctx.pinScroll();
          // Synchronous re-entrancy guard: two `click()`s land before
          // React re-renders to reflect `journalBusy`, so only a ref read
          // here — not the state below — actually stops a double-tap from
          // firing the request twice against the same, not-yet-advanced
          // cursor.
          if (journalBusyRef.current) return;
          journalBusyRef.current = true;
          setJournalBusy(true);
          // The agent's own log, not the reconstructed path — see design
          // decision 18.
          void fetchHistory(agent.agentId, journal.cursor, JOURNAL_PAGE_TURNS)
            .then((page) => {
              if (page.source !== "journal") {
                // The server has no journal for THIS pane after all — no
                // adapter, no session ref, a missing or unreadable file
                // (decision 18's "quiet in the UI" causes). Hand the pane
                // over to the reconstructed path ENTIRELY and permanently,
                // exactly as if `hasJournal` had been false from the
                // start — never retry the journal route again for it, and
                // never leave the pane pinned to the empty `journal.lines`
                // it fetched nothing into. Grant the first page of
                // reconstruction now too, so this tap is not wasted on
                // discovering the fallback alone.
                patchJournal((held) => ({ ...held, fellBack: true }));
                ctx.revealMore();
                return;
              }
              // PREPEND: a page fetched with a cursor is older than what is
              // already held. `cursor` and `done` move with it, in ONE write,
              // so a pane reopened between taps never sees lines whose cursor
              // has not caught up.
              patchJournal((held) => ({
                ...held,
                lines: [...page.lines, ...held.lines],
                cursor: page.cursor,
                // A genuine "no more journal pages" — the only case that
                // ends the affordance without a fallback.
                done: !page.hasMore,
              }));
              restore();
            })
            .catch((err) => {
              // A transient failure (network blip, herdr hiccup) is NOT
              // "no more history" and NOT "no journal" — the cached
              // `cursor` and `done` are left untouched so the next tap
              // retries the SAME page, and this is surfaced the way every
              // other action failure in this component is (`feedback`),
              // never swallowed into a permanently hidden button.
              setFeedback({
                ok: false,
                detail: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(() => {
              journalBusyRef.current = false;
              setJournalBusy(false);
            });
        }}
      >
        Show earlier
      </button>
    );
  };

  return (
    <PaneTerminal
      ref={pane}
      paneId={agent.agentId}
      title={agent.name}
      onBack={onBack}
      load={load}
      paused={busy}
      revealed={useJournal ? journal.lines : undefined}
      earlier={earlier}
      headerExtra={
        <>
          {/* Blocked renders a PILL instead of the dot; every other state keeps
              the same `StatusDot` the list renders. That is the dashboard's own
              escalation — needs-you gets a tinted, bordered treatment and the
              rest get a bare dot — and it costs nothing here: the pill's
              padding is paid for by the dot and gap it replaces, which matters
              because this header is width-starved and the agent's name is
              already truncated. Measured: the name holds at 65px either way,
              where a pill BESIDE the dot took it to 50px.

              Blocked keeps its WORD, visibly. Everywhere else the dot is enough
              and the word is only for assistive tech.

              Colour alone is not a channel a sighted colour-blind operator can
              read, and the palette pairs red with green. `AgentRow` and
              `AgentCard` get away with a bare dot because they sit under
              `Section`'s visible "Needs you" heading; this header has no such
              context. So the one state where a missed distinction has a
              consequence pays for the width, and the other three do not. */}
          {agent.state === "blocked"
            ? (
                <span className="term-state">
                  <StateIcon state="blocked" size={11} />
                  blocked
                </span>
              )
            : <>
                <StatusDot state={agent.state} />
                <span className="sr-only">{agent.state}</span>
              </>}
        </>
      }
      beforeControls={
        <>
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
                <Button
                  key={o.key}
                  type="button"
                  variant="outline"
                  className="term-option"
                  data-prompt-option={o.key}
                  disabled={busy}
                  aria-pressed={isSelected(o)}
                  onClick={() => {
                    setBusy(true);
                    void answerWithKey(agent.agentId, o.key)
                      .then((r) => setFeedback(r))
                      .finally(() => setBusy(false));
                  }}
                >
                  {/* The agent's OWN digit, not a guessed keystroke: `o.key` is what
                      herdr read off the screen and what `answerWithKey` sends
                      below, so the badge shows the key pressing this will send.
                      Rendering it makes a three-option prompt scannable at arm's
                      length instead of three similar sentences. */}
                  <span aria-hidden="true" className="term-option-key">{o.key}</span>
                  <span className="term-option-label">{o.label}</span>
                </Button>
              ))}
            </div>
          )}

          {/* What Enter would commit, right where the thumb is.

              The keypad's ↓ wraps from the last option back to the first, and the
              middle option of a permission prompt is routinely a persistent grant
              ("and don't ask again"). The wrap was never really the hazard — the
              wrap being INVISIBLE was. This is shown whenever a cursor exists, so
              it covers the prompt shapes the option parser refuses to read, which
              are exactly the ones where the keypad is the only way to answer.

              Hidden when a button above already carries the accent border for the
              same option: the two would say the same thing, and this one costs a
              bordered band plus a rule on a phone where the transcript is already
              fighting for height. */}
          {prompt?.selected && !prompt.options?.some(isSelected) && (
            <p className="term-selected" role="status">
              <span className="term-selected-label">⏎ Enter selects</span>
              {prompt.selected}
            </p>
          )}
        </>
      }
      controls={
        // Beside Wrap because both are view controls, and because a collapse
        // button INSIDE the pad would spend the height it exists to reclaim.
        // Its OWN class: sharing `.term-wrap-toggle` made a selector written
        // for the wrap control match this one too, by DOM order rather than
        // by intent. Text rather than a keyboard glyph because this file
        // already records that a symbol renders as tofu in several mobile
        // system fonts — the pressed state is carried by `aria-pressed`,
        // which the stylesheet dims.
        //
        // Three states, cycled: hidden -> compact -> full -> hidden. The pad
        // is 106px of a 390x844 phone, measured, and its default is now
        // `hidden` — a parsed prompt renders real option buttons and tapping
        // one answers in a single tap, so on the commonest blocked screen the
        // arrows were a duplicate path charging a quarter of the transcript.
        //
        // A cycle rather than two controls because this row has 36px and
        // already carries Wrap and refresh.
        //
        // The accessible name stays exactly "Keys". `aria-pressed` is gone
        // with the boolean it described, and it is NOT replaced by an
        // aria-label: this file already records that an accessible name which
        // does not contain the visible label is a WCAG 2.5.3 hazard for voice
        // control, and "Keys ·" against "Keys: arrows and Enter" is that
        // hazard. `aria-expanded` carries the part that matters instead — the
        // pad is a disclosure, which is what that attribute is for — and the
        // dots are decorative, so they are hidden from the name rather than
        // being spoken as punctuation. Which of the two open sizes is showing
        // is audible the way it is visible: the keys themselves appear.
        <button
          type="button"
          className="term-keys-toggle"
          data-state={keypad}
          aria-expanded={keypad !== "hidden"}
          onClick={() => {
            const next: Record<KeypadPref, KeypadPref> = {
              hidden: "compact", compact: "full", full: "hidden",
            };
            const v = next[keypad];
            setKeypad(v);
            writePref("keypad", v);
          }}
        >
          Keys
          {keypad !== "hidden" && (
            <span aria-hidden="true">{keypad === "compact" ? " ·" : " ··"}</span>
          )}
        </button>
      }
      afterControls={
        <>
          {/* These keys move the agent's own cursor on a screen the operator
              can see; they assert nothing about what an option means, which is
              why they work on prompt shapes the parser cannot read. */}
          {keypad !== "hidden" && (
            <div className="term-keys" data-keypad={keypad} role="group" aria-label="Send key">
              <div className="term-keys-primary">
                {PRIMARY_KEYS.map((k) => (
                  <Button
                    key={k.key} type="button" variant="outline"
                    /* Enter carries the commit — see .term-key-enter. The other two
                       only move a highlight, so they stay quiet. */
                    className={k.key === "enter" ? "term-key term-key-enter" : "term-key"}
                    data-key={k.key}
                    disabled={busy} onClick={() => void press(k.key)}
                  >
                    {k.label}
                  </Button>
                ))}
              </div>
              {keypad === "full" && (
                <div className="term-keys-secondary">
                  {SECONDARY_KEYS.map((k) => (
                    <Button
                      key={k.key} type="button" variant="outline" className="term-key term-key-sm"
                      data-key={k.key}
                      disabled={busy} onClick={() => void press(k.key)}
                      aria-label={k.key}
                    >
                      {k.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}

          <form
            className="term-reply"
            onSubmit={(e) => {
              e.preventDefault();
              if (reply.trim()) void submitReply(reply.trim());
            }}
          >
            <label className="sr-only" htmlFor="term-reply-input">Reply</label>
            <Input
              id="term-reply-input"
              value={reply}
              disabled={busy}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Type a reply…"
            />
            {/* Filled, not outline: this is the committing action. The keys above
                are `outline` because pressing one is cheap and reversible; sending a
                reply to an agent is neither. */}
            <Button type="submit" disabled={busy || !reply.trim()}>Send</Button>
          </form>
        </>
      }
    />
  );
}
