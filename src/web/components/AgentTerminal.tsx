import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult, Agent, NavKey, ParsedPrompt } from "@shared/types";
import { answerWithKey, fetchHistory, fetchOutput, fetchPrompt, sendKey, sendText } from "@web/api";
import { StatusDot } from "@web/components/AgentRow";
import { Button } from "@web/components/shadcn/button";
import { Input } from "@web/components/shadcn/input";
import { RowActions } from "@web/components/RowActions";
import { PaneTerminal, type EarlierContext, type PaneTerminalHandle } from "@web/components/PaneTerminal";
import { Keypad, KeypadToggle } from "@web/components/ui/Keypad";
import {
  emptyJournal, journalFor, updateJournal, type JournalState,
} from "@web/pane-cache";
import { readPrefs, type KeypadPref } from "@web/prefs";

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
  /**
   * Forwarded straight to `PaneTerminal`'s `backLabel` (§16.4): the caller
   * knows where `onBack` actually goes — the dashboard or `#/spaces` — and
   * this is the aria-label that has to agree with it. Omitted, `PaneTerminal`
   * falls back to its own default ("Back to agents"), which is right for
   * every caller that has no origin to report.
   */
  backLabel?: string;
}

export function AgentTerminal({ agent, onBack, backLabel }: AgentTerminalProps) {
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
    /**
     * `compact`, NOT `full`, and only from `hidden`.
     *
     * Measured on a 390x844 phone: `full` is 159px and `compact` is 60px, and
     * with the 56px control row above it the key affordance was taking 215px —
     * a QUARTER of the screen — leaving the transcript 504px. Reported as "much
     * height compared to needed", which it was.
     *
     * `compact` is the right set by this file's own reasoning, not just the
     * cheaper one: `PRIMARY_KEYS` exists because "answering a prompt from a
     * phone is up/down to move and Enter to commit", and this effect fires in
     * exactly that situation — a blocked agent whose prompt the parser could
     * not turn into buttons. Esc and Tab stay one tap away on `Keys`, which is
     * the same bargain the `promptOptionCount > 0` branch above already makes.
     *
     * Only from `hidden`, because this must not overwrite a choice. An operator
     * who deliberately set `full` was being handed `full` back, which looked
     * like agreement; one who set `compact` had it REPLACED by `full` the
     * moment an agent asked a question. The functional update reads the live
     * value without putting it in the dependency list, so the effect still runs
     * once per state change rather than on every pad change.
     */
    setKeypad((prev) => (prev === "hidden" ? "compact" : prev));
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
      backLabel={backLabel}
      load={load}
      paused={busy}
      revealed={useJournal ? journal.lines : undefined}
      earlier={earlier}
      /* The `⋯`, at the header's trailing edge. Rename only — `RowActions`
         takes `close` optionally now, and this screen cannot offer one: a
         close needs the tab that would be closed plus the panes it takes with
         it, so its consequence can be counted off the tree already on screen
         (§10). The terminal never reads the tree for an agent, so it has
         neither, and stating a consequence paddock has not counted is the one
         thing §10 forbids. Closing stays where the structure is visible.

         `onChanged` is deliberately a no-op. Every other caller refetches the
         TREE because that is what their screen renders; this header renders
         `agent.name` from the store, and an agent rename now reaches the store
         on its own — the route asks the supervisor to re-read, because herdr
         emits no event for it. Refetching a tree here would be work for a
         screen that does not read one. */
      headerActions={
        <RowActions
          label={agent.name}
          renames={[{ kind: "agent", id: agent.agentId, current: agent.name }]}
          onChanged={() => {}}
        />
      }
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
              read, and the palette pairs red with green. This pill answers that
              by its own shape: a tinted, bordered, uppercase pill against the
              bare dot every other state gets, plus the word itself. It carried
              a lucide `CircleAlert` at size 11 as a third channel, which at
              that size is 0.92px of stroke around a 9.2px circle holding a
              1.8px bar — and redundant besides, since `blocked` is the only
              state that ever renders this pill, so there is no green one here
              to confuse it with. `StateIcon` is untouched and still renders at
              its legible 13px default on `AgentCard`. */}
          {agent.state === "blocked"
            ? (
                <span className="term-state">
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
        // The shared `KeypadToggle` (`ui/Keypad.tsx`), which is where the
        // reasoning for every decision inside it now lives — placement, the
        // three-state cycle, the text label, and the WCAG 2.5.3 constraint on
        // its accessible name. It was duplicated verbatim here and in
        // `PaneTerminal`, with that reasoning present in only one copy.
        //
        // `setKeypad` is the only thing that differs between the two callers,
        // which is exactly the shape the pad itself already had.
        <KeypadToggle pad={keypad} onChange={setKeypad} />
      }
      afterControls={
        <>
          {/* These keys move the agent's own cursor on a screen the operator
              can see; they assert nothing about what an option means, which is
              why they work on prompt shapes the parser cannot read.

              The pad itself is the shared `Keypad` (`ui/Keypad.tsx`) — shared with the
              shell case (§16.3) so the two cannot drift apart. Only `onPress`
              differs: this one calls the agent's own `press`, wired to
              `agent.send_keys`. */}
          <Keypad pad={keypad} busy={busy} onPress={(k) => void press(k)} context="agent" />

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
            <Button
              type="submit"
              disabled={busy || !reply.trim()}
              // Keeps focus in the input for the length of the tap.
              //
              // Reported from a phone: "type something but cannot send, i must
              // click enter then send." A tap begins with a pointerdown, which
              // moves focus off the input; iOS then dismisses the keyboard, the
              // layout reflows upward by the keyboard's height, and this button
              // is no longer under the finger when the tap completes — so no
              // click ever arrives. Pressing return first puts the keyboard
              // away, after which the layout is still and one tap works, which
              // is exactly the "enter, then send" workaround.
              //
              // Cancelling the default here does not stop the click; it only
              // stops the focus change that moves the target out from under it.
              onPointerDown={(e) => { e.preventDefault(); }}
            >
              Send
            </Button>
          </form>
        </>
      }
    />
  );
}
