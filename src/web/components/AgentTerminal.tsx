import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult, Agent, AgentCommand, NavKey, ParsedPrompt } from "@shared/types";
import {
  answerWithKey, moveDialogTab, selectOption, sendDialogKey, sendNote, typeIntoDialog, fetchCommands, fetchHistory, fetchOutput, fetchPrompt, openFile, sendKey,
  sendText, uploadImage,
} from "@web/api";
import { commandQuery, filterCommands, replaceCommandToken } from "@web/commands";
import { fileHash } from "@shared/route";
import { AskDialogView } from "@web/components/AskDialogView";
import { CommandList } from "@web/components/CommandList";
import { QuickActions, QuickToggle } from "@web/components/QuickActions";
import { StatusDot } from "@web/components/AgentRow";
import { Button } from "@web/components/shadcn/button";
import { RowActions } from "@web/components/RowActions";
import { PaneTerminal, type EarlierContext, type PaneTerminalHandle } from "@web/components/PaneTerminal";
import { hasProse, trimSeen } from "@web/journal-overlap";
import { NotesField } from "@web/components/NotesField";
import { ChevronDownIcon, ChevronUpIcon } from "@web/components/ui/icons";
import { ImageIcon, SendIcon } from "@web/components/ui/icons";
import { Keypad, KeypadToggle } from "@web/components/ui/Keypad";
import {
  emptyJournal, journalFor, updateJournal, type JournalState,
} from "@web/pane-cache";
import { readPrefs, readQuickReplies, type KeypadPref } from "@web/prefs";

/**
 * How tall the reply field may grow before it scrolls instead.
 *
 * Five lines at the field's 16px floor. The floor is not negotiable — below it
 * iOS zooms on focus, mid-conversation — so this is expressed in pixels rather
 * than rem for the same reason the field's own font-size is.
 */
const REPLY_MAX_PX = 132;

/**
 * One image attached but not yet sent.
 *
 * `token` is identity, not decoration: two uploads can finish out of order, and
 * a positional update would then fill the wrong chip. `path === null` means the
 * upload is still in flight.
 */
interface Attachment {
  token: object;
  label: string;
  path: string | null;
  /**
   * An object URL for the local file, or null where the browser has no
   * `createObjectURL` (or refused one).
   *
   * Made from the file the operator just chose, so the thumbnail is on screen
   * before the upload finishes and costs nothing on the wire. It PINS the image
   * in memory until revoked, which on a page that stays open for days is a leak
   * — so every path that drops an attachment revokes it.
   */
  thumb: string | null;
}

/** An object URL, or null rather than throwing where the API is absent. */
function thumbFor(file: Blob): string | null {
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

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
  /**
   * Whether the operator has opened the composer while an answer panel is up.
   *
   * Sticky for the life of this pane, and that is the point: measured on a
   * phone, the chrome below the transcript took 439px of 844 while a dialog was
   * on screen, so it folds — but something that re-folded itself after being
   * opened would close under a thumb mid-reply. Nothing ever collapses it back.
   */
  const [composerOpen, setComposerOpen] = useState(false);
  const [feedback, setFeedback] = useState<ActionResult | null>(null);

  /**
   * The commands this agent's project declares.
   *
   * Fetched ONCE per agent, not per keystroke: the list is a handful of
   * entries, so it is smaller than the round trip that would filter it, and a
   * request per character would put the network between a thumb and a list.
   * Filtering is `web/commands.ts`, locally.
   *
   * A failure leaves it empty and says nothing. The autocomplete is a
   * convenience on top of a field that has to keep working, so a project
   * paddock cannot read costs the list and no more — there is deliberately no
   * error surface for a feature the operator never asked for.
   */
  /**
   * Images attached but not yet sent.
   *
   * STATE, not text in the field. The operator reads a name — `shot.png`, or
   * `[image 2]` for a capture that arrived without one — while the agent
   * receives an absolute path, so the two cannot be the same string. Composed
   * at send (`submitReply`), which is also what keeps a fifty-character path
   * out of the way of the words being typed.
   *
   * A `null` path means the upload is STILL IN FLIGHT. The chip appears the
   * moment a file is chosen, because a photo over a tunnel takes seconds and
   * silence reads as breakage — and it cannot be sent or removed until the
   * path arrives, since composing a message around a file that has no path yet
   * would send nothing for it.
   */
  const [attached, setAttached] = useState<Attachment[]>([]);
  const attachRef = useRef<HTMLInputElement>(null);

  /**
   * Whether the quick-reply panel is open. Closed at rest: the transcript is
   * what this screen is for, and these are for the moment an operator already
   * knows what they want to say.
   */
  const [quickOpen, setQuickOpen] = useState(false);
  /**
   * Read ONCE per mount, not on every render: this is the operator's own list
   * from `localStorage`, and re-reading it while they type would be a storage
   * hit per keystroke for a value that changes only in Settings.
   */
  const [quickReplies] = useState(readQuickReplies);

  const [commands, setCommands] = useState<AgentCommand[]>([]);
  useEffect(() => {
    let live = true;
    setCommands([]);
    void fetchCommands(agent.agentId)
      .then((r) => { if (live) setCommands(r.commands); })
      .catch(() => { /* the field still works; see above */ });
    return () => { live = false; };
  }, [agent.agentId]);

  /**
   * Where the caret is, so the command being edited is the one searched.
   *
   * Tracked rather than derived, because a command may sit ANYWHERE in the
   * reply — `please run /ch` — so "the end of the value" is not good enough
   * once the operator moves back into a line they have already written.
   */
  const [caret, setCaret] = useState(0);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  /**
   * A caret position to restore after a pick, or null.
   *
   * React owns the field's value, so setting it moves the caret to the end —
   * which is wrong when the command was spliced into the middle of a sentence
   * and the operator's words continue after it. Applied in an effect because it
   * has to happen AFTER the new value has been committed to the DOM.
   */
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  useEffect(() => {
    if (pendingCaret === null) return;
    const el = replyRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pendingCaret, pendingCaret);
    }
    setPendingCaret(null);
  }, [pendingCaret]);

  /**
   * The term the field is asking about, or null when it is an ordinary reply.
   *
   * Derived from the value and the caret rather than from a keystroke, so a
   * slash inside a word — `src/web`, `http://…` — is never mistaken for a
   * command, while one after a space is.
   */
  const query = commandQuery(reply, caret);
  const matches = query === null ? null : filterCommands(commands, query);
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
      // And the DIALOG, which is what an arrow key changes. Without this the
      // left/right arrows moved the agent to the next question while the UI
      // kept rendering the previous one — reported as "cannot jump to next
      // tab", with the key working the whole time.
      if (res.dialog !== undefined) {
        setPrompt((p) => (p ? { ...p, dialog: res.dialog ?? null } : p));
      }
    } else {
      setFeedback({ ok: false, detail: res.detail ?? "Key failed." });
    }
    setBusy(false);
  };

  /**
   * Upload what the picker returned, and show it as a chip.
   *
   * Uploaded on CHOICE rather than on send, so a refusal — the wrong type, or
   * a file too large — is reported while the operator is still looking at the
   * picker's outcome, not after they have written a message around it. The
   * server's own sentence is shown verbatim; it knows what it refused and why.
   *
   * The input is cleared afterwards so choosing the same file twice still
   * fires a change event.
   */
  const attach = async (files: ArrayLike<File> | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      // A camera capture often arrives with no filename; a Photo Library pick
      // usually has one. Numbered by position so two chips are never ambiguous.
      const label = file.name || `[image ${attached.length + 1}]`;
      // Shown BEFORE the request, keyed by identity rather than by index: two
      // uploads can finish out of order, and a positional update would then
      // fill the wrong chip.
      const token = {};
      const thumb = thumbFor(file);
      setAttached((prev) => [...prev, { token, label, path: null, thumb }]);
      try {
        const saved = await uploadImage(agent.agentId, file);
        setAttached((prev) => prev.map((a) => (a.token === token ? { ...a, path: saved.path } : a)));
        setFeedback(null);
      } catch (err) {
        // Withdrawn, not left pending: a chip that never resolves would block
        // Send forever with no way back.
        if (thumb) URL.revokeObjectURL(thumb);
        setAttached((prev) => prev.filter((a) => a.token !== token));
        setFeedback({ ok: false, detail: err instanceof Error ? err.message : "Upload failed." });
      }
    }
    if (attachRef.current) attachRef.current.value = "";
  };

  /**
   * A pasted image, which is the common case and the one the picker serves
   * worst: a screenshot is already on the clipboard, and reaching it through
   * Photos is three taps for a file the operator is holding.
   *
   * TEXT PASTE IS LEFT ALONE — no `preventDefault`, no interception. Pasting a
   * command or an error message into the reply is ordinary use, and swallowing
   * every paste to catch the images would break it.
   *
   * `files` is where Safari puts a pasted image; `items` is checked as well
   * because it is the older shape and costs one line.
   */
  const pasted = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    if (!data) return;

    const fromFiles = Array.from(data.files ?? []);
    const fromItems = Array.from(data.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    const images = (fromFiles.length > 0 ? fromFiles : fromItems)
      .filter((f) => f.type.startsWith("image/"));

    if (images.length === 0) return;
    // Only now: the browser must not ALSO paste a filename into the field.
    e.preventDefault();
    void attach(images);
  };

  /**
   * Grow the field to fit what is in it, up to a ceiling.
   *
   * Measured from `scrollHeight` after clearing the inline height, because a
   * stale height makes `scrollHeight` report the old size and the field then
   * only ever grows. Runs on every value change, including the one a picked
   * command splices in.
   */
  useEffect(() => {
    const el = replyRef.current;
    if (!el) return;
    el.style.height = "auto";
    // happy-dom does no layout, so `scrollHeight` is 0 there — guarded, or the
    // field would collapse to nothing in a test and, worse, in any browser that
    // reported 0 for a hidden pane.
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, REPLY_MAX_PX)}px`;
  }, [reply]);

  /**
   * Open a path tapped in the transcript.
   *
   * The path is exchanged for an id and the browser navigates to the file's own
   * route, which is what survives a reload. A refusal shows the SERVER's
   * sentence: it knows whether the file is missing, a directory, unreadable or
   * too large, and those are fixed differently.
   */
  const openPath = async (path: string) => {
    try {
      // The pane's own agent, so a relative path in this transcript resolves
      // against the directory this agent is actually running in.
      const opened = await openFile(path, agent.agentId);
      location.hash = fileHash(opened.id);
    } catch (err) {
      setFeedback({ ok: false, detail: err instanceof Error ? err.message : "Could not open that file." });
    }
  };

  /** Any upload still in flight. Send waits for it; see `attached`. */
  const uploading = attached.some((a) => a.path === null);

  /**
   * Release every thumbnail when this agent's view goes away.
   *
   * Read through a ref rather than a dependency, so the cleanup sees the LAST
   * attachments rather than the ones present when the effect was created — an
   * effect keyed on `attached` would revoke a URL that is still on screen the
   * moment a second image is added. `AgentDetail` mounts this keyed by agent
   * id, so switching agents runs this.
   */
  const held = useRef<Attachment[]>([]);
  held.current = attached;
  useEffect(() => () => {
    for (const a of held.current) if (a.thumb) URL.revokeObjectURL(a.thumb);
  }, []);

  /**
   * Send one reply.
   *
   * `source` decides only what is CLEARED afterwards. A reply typed in the
   * field empties it, because that text has now been said. A quick action has
   * its own text and must leave whatever the operator was part-way through
   * writing — discarding a draft to make room for "Yes" is the worse surprise,
   * and it is silent.
   *
   * Attachments are consumed either way: they are part of the pending message
   * whichever text carries them, and leaving them behind would send the same
   * image again with the next reply.
   */
  const submitReply = async (text: string, source: "field" | "quick" = "field") => {
    setBusy(true);
    // `sendText`, NOT `answerWithText`. The latter answers a prompt and is
    // refused with a 409 the moment the agent stops being blocked — which is
    // three states out of four, and was why this box always failed.
    // Paths first, then the words. The agent needs the path before it can be
    // told what to do with the image, and this is the only place the two are
    // ever joined — the field itself never held a path.
    const composed = [...attached.map((a) => a.path ?? ""), text]
      .filter((p) => p !== "")
      .join(" ");
    const res = await sendText(agent.agentId, composed);
    if (res.ok) {
      if (source === "field") setReply("");
      for (const a of attached) if (a.thumb) URL.revokeObjectURL(a.thumb);
      setAttached([]);
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
          /**
           * One page, with the first one bounded against the live screen.
           *
           * `follow` exists for the case the trim leaves nothing: page one can
           * be entirely on screen, and a tap that then rendered nothing would
           * be a control that looks broken. It runs ONCE — never a loop — so a
           * journal whose every page overlaps costs one extra request, not an
           * unbounded run of them.
           */
          const load = (cursor: string | null, first: boolean): Promise<void> =>
            fetchHistory(agent.agentId, cursor, JOURNAL_PAGE_TURNS)
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
              // The FIRST page is the newest turns, because it is fetched with
              // no cursor and the reader reads that as "from the end of the
              // file" — so most of it is already on the screen below. Every
              // later page carries a cursor and is genuinely older, and is
              // taken whole.
              const fresh = first ? trimSeen(page.lines, ctx.onScreen) : page.lines;

              // PREPEND: a page fetched with a cursor is older than what is
              // already held. `cursor` and `done` move with it, in ONE write,
              // so a pane reopened between taps never sees lines whose cursor
              // has not caught up.
              patchJournal((held) => ({
                ...held,
                lines: [...fresh, ...held.lines],
                cursor: page.cursor,
                // A genuine "no more journal pages" — the only case that
                // ends the affordance without a fallback.
                done: !page.hasMore,
              }));
              restore();

              // NOTHING READABLE survived the trim — which is not the same
              // as nothing at all. A short session whose every turn is already
              // on screen leaves a bare `you · 18:58` behind, and measured in
              // the browser that grew the transcript by eleven characters and
              // read as a broken button. So the test is whether there is prose
              // to read, not whether the array is empty.
              //
              // Bounded, never a loop to the end of the file: each try costs a
              // request, and a journal that is genuinely exhausted sets `done`
              // through `hasMore` and takes the button away honestly.
              // Gated on the trim having actually REMOVED something. A page
              // that is simply short is honest content and the operator asked
              // for it; only a page emptied out by the trim is the dead tap,
              // and only the first page is ever trimmed. So this costs at most
              // one extra request, once.
              const trimmed = fresh.length < page.lines.length;
              if (first && trimmed && !hasProse(fresh) && page.hasMore && page.cursor !== null) {
                return load(page.cursor, false);
              }
              return undefined;
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

          void load(journal.cursor, journal.lines.length === 0 && journal.cursor === null);
        }}
      >
        Show earlier
      </button>
    );
  };

  /**
   * Is there a panel on screen that already answers this question?
   *
   * Both shapes count, and they are mutually exclusive: the recognised dialog
   * REPLACES the option block. The multi-select one carries its own free-text
   * row, so folding the composer under it removes no way of answering at all.
   */
  const hasAnswerPanel = Boolean(prompt?.dialog) || Boolean(prompt?.options?.length);

  /**
   * Folded only when there is another way to answer.
   *
   * A parse that produced nothing leaves the reply field as the ONLY answer —
   * the fallback this project keeps for every prompt it refuses to read — so it
   * stays open there, and on any pane with no question at all.
   */
  /**
   * Is folding safe right now?
   *
   * NEVER over an open keypad: "the pad never closes itself once it is open" is
   * an existing rule with a test of its own, and a dialog arriving while the
   * operator has the pad up would otherwise close it under their thumb.
   *
   * NEVER over work in progress either. A half-typed reply or a staged image
   * folded out of sight is lost or sent unseen — the same objection that keeps
   * a typed note from collapsing.
   */
  const canFold = keypad === "hidden" && reply.trim() === "" && attached.length === 0;

  const folded = hasAnswerPanel && !composerOpen && canFold;

  /**
   * The way back down, offered whenever folding is safe and the composer is up.
   *
   * The first version of this folded on its own and could then only be opened,
   * which the operator hit immediately: "its can show, but how can I hide it
   * again?" Sticky-open exists to stop the composer closing under a thumb
   * mid-reply — that argues against re-folding AUTOMATICALLY, not against
   * offering the fold at all.
   *
   * Withdrawn rather than disabled when unsafe: a disabled button invites a tap
   * at the one moment it will not work.
   */
  const canUnfold = hasAnswerPanel && composerOpen && canFold;

  return (
    <PaneTerminal
      ref={pane}
      onOpenPath={(path) => void openPath(path)}
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
          {/* A recognised dialog replaces the option block entirely — it is the
              same job done with the state the screen actually carries. When the
              new parser refuses (`dialog === null`), which is every permission
              prompt and every other harness, nothing below changes at all. */}
          {prompt?.dialog && (
            <AskDialogView
              dialog={prompt.dialog}
              busy={busy}
              onToggle={(key) => {
                setBusy(true);
                void sendDialogKey(agent.agentId, key)
                  .then((r) => {
                    if (!r.ok) { setFeedback({ ok: false, detail: r.detail ?? "Failed." }); return; }
                    // The screen and the dialog together: the mark the operator
                    // just tapped has to come from what the agent now shows,
                    // not from a local mirror that could disagree with it.
                    if (r.lines) pane.current?.apply(r.lines);
                    // BOTH, always together: they describe the same screen, and
                    // patching one alone is how the "Enter selects" line came to
                    // show a previous question's answer.
                    setPrompt((p) => (p === null ? p : {
                      ...p,
                      dialog: r.dialog ?? p.dialog,
                      selected: r.selected !== undefined ? r.selected : p.selected,
                    }));
                    setFeedback(null);
                  })
                  .finally(() => setBusy(false));
              }}
              onArrow={(dir) => {
                setBusy(true);
                // NOT `press(dir)`: a plain nav key pauses once and reports
                // whatever the screen says then, which returned the previous
                // question whenever the repaint was slower than the guess. This
                // waits until the question changes.
                void moveDialogTab(agent.agentId, dir)
                  .then((r) => {
                    if (!r.ok) { setFeedback({ ok: false, detail: r.detail ?? "Failed." }); return; }
                    if (r.lines) pane.current?.apply(r.lines);
                    // BOTH, always together: they describe the same screen, and
                    // patching one alone is how the "Enter selects" line came to
                    // show a previous question's answer.
                    setPrompt((p) => (p === null ? p : {
                      ...p,
                      dialog: r.dialog ?? p.dialog,
                      selected: r.selected !== undefined ? r.selected : p.selected,
                    }));
                    setFeedback(null);
                  })
                  .finally(() => setBusy(false));
              }}
              onType={(text) => {
                setBusy(true);
                void typeIntoDialog(agent.agentId, text)
                  .then((r) => {
                    if (!r.ok) { setFeedback({ ok: false, detail: r.detail ?? "Failed." }); return; }
                    if (r.lines) pane.current?.apply(r.lines);
                    // BOTH, always together: they describe the same screen, and
                    // patching one alone is how the "Enter selects" line came to
                    // show a previous question's answer.
                    setPrompt((p) => (p === null ? p : {
                      ...p,
                      dialog: r.dialog ?? p.dialog,
                      selected: r.selected !== undefined ? r.selected : p.selected,
                    }));
                    setFeedback(null);
                  })
                  .finally(() => setBusy(false));
              }}
            />
          )}

          {/* ABSENT is treated exactly as null, not as a third case. A body
              without the field — an older server, or any response that omits it
              — must fall back to these buttons rather than render neither: a
              screen with no controls at all is the silent disabling this
              project refuses elsewhere. */}
          {!prompt?.dialog && prompt?.options && prompt.options.length > 0 && (
            <div
              className="term-options"
              /* A question dialog's rows CHOOSE; a permission prompt's rows
                 ACT. Same markup, so the roles have to differ or a screen
                 reader hears "pressed" for a selection that sent nothing. */
              role={prompt.commit === "cursor" ? "radiogroup" : "group"}
              aria-label="Answer"
              data-tour="answer-options"
            >
              {prompt.question && <p className="term-question">{prompt.question}</p>}
              {prompt.options.map((o) => (
                <Button
                  key={o.key}
                  type="button"
                  variant="outline"
                  className="term-option"
                  data-prompt-option={o.key}
                  disabled={busy}
                  role={prompt.commit === "cursor" ? "radio" : undefined}
                  aria-checked={prompt.commit === "cursor" ? isSelected(o) : undefined}
                  aria-pressed={prompt.commit === "cursor" ? undefined : isSelected(o)}
                  onClick={() => {
                    setBusy(true);
                    // WHICH keystroke answers this prompt is the prompt's to
                    // say, not ours to assume. A permission prompt takes its
                    // digit; a question dialog ignores digits entirely and
                    // wants its cursor walked onto the row — measured, a digit
                    // sent there did nothing and the wait for an unblock then
                    // timed out and reported a failure for a keystroke that
                    // never landed.
                    //
                    // A QUESTION DIALOG IS NOT ANSWERED BY TAPPING AN OPTION.
                    // It is deliberative — a preview panel, a notes field — and
                    // the operator is choosing before committing. Reported from
                    // a phone: "I click 2 with purpose choose option 2 to add
                    // note but it send immediately." So a tap MOVES the cursor
                    // here, exactly as ↑/↓ do in the TUI, and the send button
                    // below commits. A permission prompt still answers on one
                    // tap, which is what paddock exists for.
                    const act = prompt.commit === "cursor"
                      ? selectOption(agent.agentId, o.key, false)
                      : answerWithKey(agent.agentId, o.key);
                    void act
                      .then((r) => {
                        setFeedback(r.ok ? null : r);
                        if ("lines" in r && r.lines) pane.current?.apply(r.lines);
                        // The cursor moved, so what Enter would commit moved
                        // with it — and the send button's label names it.
                        const moved = (r as { selected?: string | null }).selected;
                        if (r.ok && moved !== undefined) {
                          setPrompt((p) => (p === null ? p : { ...p, selected: moved }));
                        }
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  {/* The agent's OWN digit, not a guessed keystroke: `o.key` is what
                      herdr read off the screen and what `answerWithKey` sends
                      below, so the badge shows the key pressing this will send.
                      Rendering it makes a three-option prompt scannable at arm's
                      length instead of three similar sentences. */}
                  {/* The mark is the affordance: a dot says CHOSEN where a
                      border alone said only "highlighted", and these rows are
                      otherwise identical to the ones that answer on one tap. */}
                  {prompt.commit === "cursor" && (
                    <span aria-hidden="true" className="term-option-mark">
                      {isSelected(o) ? "●" : "○"}
                    </span>
                  )}
                  <span aria-hidden="true" className="term-option-key">{o.key}</span>
                  <span className="term-option-label">{o.label}</span>
                </Button>
              ))}
            </div>
          )}

          {/* The dialog's notes field, offered only when the dialog has one.

              Two send buttons, because the agent receives two different
              answers: measured, Enter with the field open submits the note
              ALONE and discards the option the cursor is sitting on, while Esc
              first keeps the note and lets Enter commit both. A single Send
              would have to guess between them, and guessing wrong throws away
              the operator's choice while the screen still shows it highlighted. */}
          {prompt?.notes && (
            <NotesField
              optionKey={prompt.options?.find((o) => isSelected(o))?.key ?? null}
              busy={busy}
              onSend={(text, mode) => {
                setBusy(true);
                // An empty note with an option is not a note at all — it is the
                // option on its own, and `/note` refuses empty text by design.
                // Tapping an option only MOVES the cursor now, so this is the
                // path that actually commits one.
                const act = text.trim() === "" && mode === "with-option" && prompt.options
                  ? selectOption(
                      agent.agentId,
                      prompt.options.find((o) => isSelected(o))?.key ?? prompt.options[0]!.key,
                      true,
                    )
                  : sendNote(agent.agentId, text, mode);
                void act
                  .then((r) => {
                    if (!r.ok) { setFeedback({ ok: false, detail: r.detail ?? "Failed." }); return; }
                    if (r.lines) pane.current?.apply(r.lines);
                    setFeedback(null);
                  })
                  .finally(() => setBusy(false));
              }}
            />
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
          {/* Hidden while a dialog is on screen: the panel above already shows
              the question, the options and their state, and this line was
              duplicating it — including, once, a previous question's answer.
              It stays for every prompt the dialog parser refuses, where it is
              the only thing that says what Enter will commit. */}
          {!prompt?.dialog && prompt?.selected && !prompt.options?.some(isSelected) && (
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
        folded ? (
          /* NAMED, not a bare chevron. On touch there is no hover to reveal
             what a glyph means, and a control nobody can identify is one they
             have to find by poking. */
          <button
            type="button"
            className="term-fold"
            aria-expanded="false"
            onClick={() => setComposerOpen(true)}
          >
            <ChevronUpIcon className="term-fold-glyph" />
            Reply · Keys
          </button>
        ) : (
        <>
          {canUnfold && (
            <button
              type="button"
              className="term-unfold"
              aria-expanded="true"
              onClick={() => setComposerOpen(false)}
            >
              <ChevronDownIcon className="term-fold-glyph" />
              Hide
            </button>
          )}
          <KeypadToggle pad={keypad} onChange={setKeypad} />
          {/* No replies, no control. An operator who cleared the list gets no
              toggle rather than one that opens an empty panel. */}
          {quickReplies.length > 0 && (
            <QuickToggle open={quickOpen} onToggle={() => setQuickOpen((v) => !v)} />
          )}

          {/* STOP, and only while the agent is WORKING.

              `^C` already existed — but inside the key pad's `full` layout, and
              the pad defaults to `hidden`, so interrupting was three taps and
              required knowing the toggle cycles through three states. The pad's
              own comment calls interrupting "the one control act reached for in
              a hurry", which is a poor fit for the least reachable control on
              the screen.

              Not always present, deliberately: an interrupt on an idle agent
              has nothing to interrupt and is an accident waiting to happen. The
              state already says which case this is.

              Immediate, with no confirm, for the same reason it is here at all —
              a confirmation step defeats "in a hurry", and the pad's existing
              `^C` is immediate too. The danger colour is what carries the
              weight instead. */}
          {agent.state === "working" && (
            <button
              type="button"
              className="term-stop"
              disabled={busy}
              onClick={() => void press("ctrl-c")}
            >
              <span aria-hidden="true" className="term-stop-glyph">■</span>
              Stop
            </button>
          )}
        </>
        )
      }
      /* The keypad and the reply form: the taller half of the chrome, and the
         half a parsed answer panel makes redundant. Folded with the toggles
         above rather than separately — two controls that vanish independently
         are two things to hunt for. */
      afterControls={folded ? null : (
        <>
          {/* These keys move the agent's own cursor on a screen the operator
              can see; they assert nothing about what an option means, which is
              why they work on prompt shapes the parser cannot read.

              The pad itself is the shared `Keypad` (`ui/Keypad.tsx`) — shared with the
              shell case (§16.3) so the two cannot drift apart. Only `onPress`
              differs: this one calls the agent's own `press`, wired to
              `agent.send_keys`. */}
          <Keypad pad={keypad} busy={busy} onPress={(k) => void press(k)} context="agent" />

          {quickOpen && (
            <QuickActions
              replies={quickReplies}
              busy={busy || uploading}
              // Sends ITS OWN text and leaves the field alone: a draft the
              // operator is part-way through is theirs, and discarding it to
              // make room for "Yes" would be the worse surprise. Closing after
              // is both a receipt and a guard — an open panel under a thumb
              // invites the second tap that sends a reply twice.
              onSend={(text) => {
                setQuickOpen(false);
                void submitReply(text, "quick");
              }}
            />
          )}

          {attached.length > 0 && (
            <div className="term-atts">
              {attached.map((a, i) => (
                <span className="term-att" key={a.label + String(i)} data-pending={a.path === null ? "" : undefined}>
                  {a.thumb && <img className="term-att-thumb" src={a.thumb} alt="" />}
                  <span className="term-att-name">{a.label}</span>
                  {a.path === null ? (
                    <span className="term-att-spin" role="status" aria-label="Uploading" />
                  ) : (
                    <button
                      type="button"
                      className="term-att-x"
                      // Visible, not a swipe or a long-press: removing an
                      // attachment must not need a gesture only someone who
                      // already knows would find.
                      aria-label={`Remove ${a.label}`}
                      onPointerDown={(e) => { e.preventDefault(); }}
                      onClick={() => {
                        if (a.thumb) URL.revokeObjectURL(a.thumb);
                        setAttached((prev) => prev.filter((_, at) => at !== i));
                      }}
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          {matches !== null && (
            <CommandList
              matches={matches}
              exhausted={commands.length === 0}
              busy={busy}
              // Splices the typed token, keeping whatever surrounds it: the
              // command may be the second half of a sentence, and assigning
              // the whole value would delete the words around it. The appended
              // space closes the list and is where an argument goes.
              onPick={(c) => {
                const next = replaceCommandToken(reply, caret, c.command);
                setReply(next.value);
                setCaret(next.caret);
                setPendingCaret(next.caret);
              }}
            />
          )}

          <form
            className="term-reply"
            onSubmit={(e) => {
              e.preventDefault();
              // An attachment ALONE is a legitimate message — "look at this" —
              // so the guard cannot key on the text. Keying it on `reply` made
              // an image with no words silently unsendable.
              if (uploading) return;
              if (reply.trim() || attached.length > 0) void submitReply(reply.trim());
            }}
          >
            <label className="sr-only" htmlFor="term-attach-input">Attach an image</label>
            <input
              id="term-attach-input"
              ref={attachRef}
              className="sr-only"
              type="file"
              // The phone's own picker — Photo Library, Take Photo, Files —
              // for free, and the only list of types worth declaring is the
              // one the server will actually accept.
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              onChange={(e) => void attach(e.target.files)}
            />
            <Button
              type="button"
              variant="outline"
              className="term-attach"
              disabled={busy}
              aria-label="Attach an image"
              onPointerDown={(e) => { e.preventDefault(); }}
              onClick={() => attachRef.current?.click()}
            >
              <ImageIcon />
            </Button>
            <label className="sr-only" htmlFor="term-reply-input">Reply</label>
            {/* A TEXTAREA, not an input, and grown from its own content.

                A three-sentence instruction to an agent scrolled out of sight
                in a single-line field, so the operator committed text they
                could not read — which is the same objection paddock already
                makes about the agent's own options. One row at rest, because
                the transcript is what this screen is for; it grows to five and
                then scrolls.

                `rows={1}` plus a height set from `scrollHeight` rather than a
                CSS `field-sizing`: that property is not in Safari on the
                versions this has to work on, and this field is the one control
                a phone operator cannot do without. */}
            <textarea
              id="term-reply-input"
              ref={replyRef}
              className="term-reply-field"
              data-tour="reply-field"
              rows={1}
              value={reply}
              disabled={busy}
              onChange={(e) => {
                setReply(e.target.value);
                // `selectionStart` is null for input types that have no
                // selection; the end of the value is where typing leaves it.
                setCaret(e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={(e) => {
                // Return makes a NEWLINE here, which a textarea does for free.
                // The single-line field it replaced submitted on Return, so a
                // keyboard would otherwise be left with no way to send at all —
                // hence the modifier. Both modifiers, because a Mac has no Ctrl
                // under that thumb.
                if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
                e.preventDefault();
                if (uploading) return;
                if (reply.trim() || attached.length > 0) void submitReply(reply.trim());
              }}
              onPaste={pasted}
              // The caret also moves without the value changing — a tap into
              // the middle of the line, or an arrow key — and the list has to
              // follow it, or it would keep offering matches for a token the
              // operator has already left.
              onSelect={(e) => {
                const el = e.currentTarget;
                setCaret(el.selectionStart ?? el.value.length);
              }}
              placeholder="Type a reply…"
            />
            {/* Filled, not outline: this is the committing action. The keys above
                are `outline` because pressing one is cheap and reversible; sending a
                reply to an agent is neither. */}
            <Button
              type="submit"
              className="term-send"
              aria-label="Send"
              disabled={busy || uploading || (!reply.trim() && attached.length === 0)}
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
              {/* The glyph ALONE here, unlike `Keys` and `Quick` beside it.
                  WCAG 2.5.3 is about a visible label matching the accessible
                  name; with no visible text there is nothing to mismatch, and
                  `aria-label` supplies the name. Send earns the exception the
                  toggles do not: it is the one control on this row whose
                  meaning is universal, and the width it gives back goes to the
                  field, which is what an operator is actually looking at. */}
              <SendIcon className="term-send-glyph" />
            </Button>
          </form>
        </>
      )}
    />
  );
}
