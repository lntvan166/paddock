import { useEffect, useId, useRef, useState } from "react";
import { useKeyboardInset } from "@web/keyboard-inset";
import { paneHash } from "@shared/route";
import type { CreateSpaceResult, CreateTabResult } from "@shared/types";
import { createSpace, createTab, fetchHarnessKinds, startAgent } from "@web/api";
import { launchAgent, type StartSender } from "@web/launch";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from "@web/components/shadcn/sheet";

/**
 * The `+` and the sheet it opens.
 *
 * WHERE the control sits is the requirement, not a layout preference (§16.7):
 * a `+` in the Spaces header makes a SPACE, a `+` on a space row makes a tab
 * IN THAT SPACE. Position carries the scope, which is why neither needs a text
 * label — and why this component takes the scope as `target` rather than
 * deciding it from anything it can see.
 *
 * Two things it deliberately does not do:
 *
 * - It is not a floating action button. Collie's create control lives inside
 *   the header it creates into, and that is the part worth copying; its 36 px
 *   size is not — every tap target in paddock clears 44 px.
 * - It is never rendered when the tree is unavailable. That gate lives in the
 *   CALLER (`Spaces` reads `spacesAvailable`), for the same reason the Spaces
 *   entry point in `App.tsx` is gated there: a control that always errors is
 *   worse than no control, which `routes.ts` records on `/ack`'s Dismiss
 *   button. A capability, never a demo flag, a hostname or a device check.
 *
 * shadcn's `Sheet`, the same primitive `RowActions` uses, for the same reason
 * `CLAUDE.md` sanctions it: focus trap, scroll lock, escape handling — the
 * things a bottom sheet on a phone is felt getting wrong.
 */

/**
 * What this `+` makes, and what it knows about where.
 *
 * A tab carries its space's own label and cwd because both are DEFAULTS the
 * sheet pre-fills from (§9.3, §14.7) and the caller already has them on the
 * row it is drawing. Rebuilding either here would be a second expression of a
 * rule that has one home.
 */
export type CreateTarget =
  | { kind: "space" }
  | {
    kind: "tab";
    spaceId: string;
    /**
     * The space's OWN label, and `null` when it has none — never the `spaceId`
     * substituted for one.
     *
     * The row above this control renders an unnamed space as its id (`w1`,
     * `w3`), because a row has to say something. Passing that string on as the
     * label was how a herdr COORDINATE became an agent's suggested name — the
     * exact thing `docs/gotchas.md` and `adapter.ts`'s three-rung labelling
     * exist to prevent ("`w3:p1` is correct and useless"), from the write side
     * and durably. So the caller passes what herdr actually holds, and the two
     * consumers below make their own decision: the heading falls back to the
     * id, the suggested NAME does not fall back at all.
     */
    spaceLabel: string | null;
    /** The space's own working directory — its first pane's — or null when the
     *  tree does not say. Null means "let herdr pick", never a guessed path. */
    spaceCwd: string | null;
  };

/**
 * The writes this sheet makes, injected — the same contract and the same
 * reason as `RowSenders`: a component test drives a create without a network,
 * and a failure is a value this component renders rather than a thrown
 * promise. `harnesses` is a READ, and it is here rather than a second
 * injection point because it is a read this sheet makes on the operator's
 * behalf, at the moment they open it.
 */
export interface CreateSenders {
  harnesses(): Promise<string[]>;
  createSpace(opts: { label?: string; cwd?: string }): Promise<CreateSpaceResult>;
  createTab(spaceId: string, opts: { label?: string; cwd?: string }): Promise<CreateTabResult>;
  startAgent: StartSender;
}

/** The real clients from `api.ts`, wrapped so the optional `fetch` parameter
 *  each one carries stays out of the interface above. */
export const LIVE_CREATE_SENDERS: CreateSenders = {
  harnesses: async () => (await fetchHarnessKinds()).kinds,
  createSpace: (opts) => createSpace(opts),
  createTab: (spaceId, opts) => createTab(spaceId, opts),
  startAgent: (paneId, kind, name) => startAgent(paneId, kind, name),
};

/**
 * herdr's own naming convention, in one place.
 *
 * §14.7 measured that herdr initialises an agent's `name` to the SLUG of its
 * workspace label, so a space called `api refactor` gets an agent called
 * `api-refactor`. Two consumers need that rule and they must not drift: this
 * sheet pre-fills the name field with it, and `SpaceRow`'s `sameLabel` uses it
 * to decide whether a merged row's alias says anything the space label does
 * not — the comparison that, spelled a second way, printed every merged row's
 * title twice (§16.1).
 */
export function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The picker's value for "no agent at all". The empty string, because that is
 *  what an unset `<select>` naturally holds and because no herdr harness kind
 *  can be empty — `routes.ts` refuses an empty `kind` with 400. */
const SHELL = "";

export function CreateSheet({
  target, cwds, onChanged,
  senders = LIVE_CREATE_SENDERS,
  navigate = (hash: string) => { location.hash = hash; },
  variant = "glyph",
  openWhen,
  onOpenChange,
  preset,
}: {
  target: CreateTarget;
  /** Every cwd already in the tree, offered as quick picks (§9.3). The
   *  snapshot already carries them, so this costs nothing — and it is the
   *  whole improvement over asking someone to type a filesystem path on a
   *  phone keyboard. There is deliberately NO directory browsing: that needs
   *  a filesystem-listing endpoint, which is its own security surface. */
  cwds: string[];
  /** Re-read the tree. Called after the create, win or lose (§11) — no
   *  optimistic update, same as `RowActions`. */
  onChanged: () => void;
  senders?: CreateSenders;
  /** Injected so a test can observe the navigation rather than mutate the
   *  document's hash. */
  navigate?: (hash: string) => void;
  /**
   * How the trigger presents itself.
   *
   * `glyph` (the default) is the bare `+` §16.7 puts in a header, where
   * POSITION carries the scope and no text label is needed. `row` is the same
   * sheet presented as the last row of the list it adds to — on the space
   * screen there is no header position that says "a tab in this space", so the
   * control says it in words instead.
   *
   * Existing call sites are untouched by construction: the default is what
   * they already render.
   */
  variant?: "glyph" | "row";
  /**
   * Drive the sheet from somewhere else, and render no trigger of its own.
   *
   * The dashboard's quick-add dial is the one caller: it IS the trigger, and a
   * second `+` inside the sheet's own markup would be a control nobody can
   * reach. `undefined` leaves the sheet self-triggering, which is what every
   * existing call site already does.
   */
  openWhen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Which of the picker's two answers to arrive on.
   *
   * The dial asks "Agent or Terminal?" before the sheet opens, and that IS the
   * picker's first field — `plain shell — no agent` versus a harness kind. So
   * this pre-answers it rather than asking twice.
   *
   * `"agent"` selects the FIRST installed harness once the list has loaded,
   * and the picker stays editable: paddock does not know which harness you
   * meant, only that you did not mean a shell. `"shell"` is what the sheet
   * already defaults to, so it is named for symmetry rather than need.
   */
  preset?: "shell" | "agent";
}) {
  const [selfOpen, setSelfOpen] = useState(false);
  const controlled = openWhen !== undefined;
  const open = controlled ? openWhen : selfOpen;
  // Hold the sheet above the on-screen keyboard while it is open. Tracked only
  // while open — see the hook's note on why a page-lifetime listener would be
  // wrong. Absent `visualViewport`, this does nothing at all.
  useKeyboardInset(open);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState(SHELL);
  const [kinds, setKinds] = useState<string[]>([]);
  const [nameDraft, setNameDraft] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [cwdDraft, setCwdDraft] = useState("");
  const [cwdEdited, setCwdEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cwdListId = useId();

  /**
   * Apply `preset: "agent"` when the harness list lands.
   *
   * It cannot be applied at open: `kinds` is fetched, so at that moment there
   * is nothing to select. Guarded on `kind === SHELL` so this only ever moves
   * the field OFF its default — once the operator has chosen a harness, a late
   * read resolving must not overwrite them.
   */
  useEffect(() => {
    if (!open || preset !== "agent") return;
    if (kinds.length === 0) return;
    setKind((current) => (current === SHELL ? kinds[0]! : current));
  }, [open, preset, kinds]);

  /**
   * The dial's flow, where the point is speed.
   *
   * `preset` is only ever passed by `QuickAdd`, so it doubles as "this was
   * started from the dial" without a second prop that could disagree with it.
   * Quick mode hides the two fields the operator has already answered — the
   * picker (answered by which entry they chose) and the agent name (derived
   * from the one name they type) — leaving a name and a folder.
   */
  const quick = preset !== undefined;

  const isSpace = target.kind === "space";
  const what = isSpace ? "space" : "tab";
  /** Where this tab is going, for the heading and the accessible name. The id
   *  IS the honest answer for an unnamed space — it is what the row shows, and
   *  the sheet must agree with the row it opened from. */
  const where = isSpace ? "" : target.spaceLabel ?? target.spaceId;
  /**
   * Named for what the operator ASKED FOR, not for the record it produces.
   *
   * From the dial they tapped "Agent" or "Terminal", so "New space" answered a
   * question nobody had asked — and it made the sheet look like the wrong one
   * had opened. Reported as: its name should be "new agent" instead of space.
   *
   * The structural truth is not hidden, it has just moved to where it belongs:
   * the description below still says "A new space, with one tab and one pane in
   * it", so what is actually created is one line down rather than absent. Title
   * carries intent, description carries mechanism.
   */
  const title = quick
    ? (preset === "agent" ? "New agent" : "New terminal")
    : isSpace ? "New space" : `New tab in ${where}`;

  /**
   * The name the agent gets, unless the operator says otherwise.
   *
   * Derived on every render rather than pushed into state by an effect, which
   * is what makes the space case track the label AS IT IS TYPED with no
   * synchronisation to get wrong.
   *
   * It is NOT the harness kind, and that is a reversal rather than an
   * oversight: defaulting to `kind` was implemented and reviewed, and every
   * agent spawned from the phone would then have come out `claude`, which
   * paddock's own disambiguation renders as `claude`, `claude 2`, `claude 3`.
   * The slug of the space's label is what herdr itself writes when a human
   * starts an agent (§14.7), so the common case is still one tap.
   *
   * And it is EMPTY when there is no label to slugify — an unnamed space, which
   * is the common case because herdr numbers them by default. It used to be
   * `slug(spaceId)`, so `w1` was submitted as the agent's real herdr `name`:
   * a coordinate written as a name, durably, until someone renamed it. Submit
   * is already disabled on a blank name for a harness, so the operator is asked
   * for a name exactly when paddock has nothing honest to suggest.
   */
  const nameSource = isSpace ? label : target.spaceLabel;
  const suggested = nameSource === null ? "" : slug(nameSource);
  const name = nameEdited ? nameDraft : suggested;

  /** A new tab inherits its space's directory; a new space has none to
   *  inherit, and an empty value asks herdr for its own default rather than
   *  guessing a path. */
  const defaultCwd = isSpace ? "" : target.spaceCwd ?? "";
  const cwd = cwdEdited ? cwdDraft : defaultCwd;

  /**
   * The installed kinds, read when the sheet opens.
   *
   * Per open, not once per mount: there is one of these controls per space row
   * plus one in the header, and reading `server.agent_manifests` for every one
   * of them on a screen the operator may never create anything from is a cost
   * with no reader. A failed read is SHOWN — the picker then offers a plain
   * shell and nothing else, which is honest about what paddock knows, rather
   * than a hardcoded list (§9.3: `kind` is a plain string in protocol 20, so
   * the only defensible allowlist is what is actually installed).
   */
  // Read through a ref, so `open` is the only dependency. A caller that
  // builds its senders inline gets a new object every render; with `senders`
  // in the dependency list, `setKinds` would re-render, the identity would
  // change, and the effect would fetch again — forever.
  const sendersRef = useRef(senders);
  sendersRef.current = senders;
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      try {
        const found = await sendersRef.current.harnesses();
        if (live) setKinds(found);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { live = false; };
  }, [open]);

  const show = (next: boolean) => {
    if (controlled) onOpenChange?.(next); else setSelfOpen(next);
    // Reopens blank, never carrying a half-filled form or a stale error from
    // the last attempt — the same rule `RowActions` applies to an armed close.
    if (!next) {
      setLabel(""); setKind(SHELL); setNameDraft(""); setNameEdited(false);
      setCwdDraft(""); setCwdEdited(false); setError(null);
      // `kinds` too, and it was the one that got left out — which falsified the
      // comment on the read above ("A failed read is SHOWN — the picker then
      // offers a plain shell and nothing else"). On any open after a successful
      // one, a failed read showed its error with the STALE list still beside
      // it: harnesses paddock had just failed to confirm were installed.
      setKinds([]);
    }
  };

  /**
   * Create, then spawn — two calls, because `agent.start` needs a pane that
   * already exists (§9.2), and two steps in the operator's head as well.
   *
   * The navigation happens as soon as the pane exists, BEFORE the agent is up:
   * the shell renders (§8 made it renderable), so the operator lands on the
   * tab they just made. `launchAgent` therefore reports through the launch
   * store rather than back to this component, which is unmounted by that
   * navigation — see `launch.ts`. A create that FAILS navigates nowhere and
   * keeps the sheet open carrying herdr's own words.
   */
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = {
        label: label.trim() === "" ? undefined : label.trim(),
        cwd: cwd.trim() === "" ? undefined : cwd.trim(),
      };
      const created = target.kind === "space"
        ? await senders.createSpace(opts)
        : await senders.createTab(target.spaceId, opts);
      onChanged();
      // Checked BEFORE `paneId` is read, for the reason `launch.ts` gives on
      // the same check: `readJson` rejects on a non-2xx status but validates
      // nothing about a 200's body, so a 200 saying `ok: false` — or one with
      // no `paneId` at all — would resolve here as a value TypeScript believes
      // is a success. Unguarded, that navigated to `#/pane/undefined`: a
      // create the operator is told worked, landing them on a pane that does
      // not exist. Two files close this path and they must close it the same
      // way.
      if (created.ok === false) {
        throw new Error(created.detail ?? `the ${what} was not created`);
      }
      if (typeof created.paneId !== "string" || created.paneId === "") {
        throw new Error(`the ${what} was created, but herdr named no pane in it`);
      }
      // Started before the navigate, so `starting <kind>…` is already in the
      // store by the time the pane's screen mounts and reads it.
      if (kind !== SHELL) void launchAgent(created.paneId, kind, name.trim(), senders.startAgent);
      navigate(paneHash(created.paneId));
      show(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // A harness with no name is a request the route refuses with 400 (`name`
  // is REQUIRED), so the control says so instead of sending it — the same
  // reasoning as Save on an empty rename label. A plain shell has no agent to
  // name and is never blocked by this.
  const unnamed = kind !== SHELL && name.trim() === "";

  return (
    <Sheet open={open} onOpenChange={show}>
      {/* No trigger when something else opens this — see `openWhen`. */}
      {!controlled && <SheetTrigger
        data-create={what}
        className={variant === "row" ? "create-row" : "create-btn"}
        // Position carries the scope when this is a glyph in a header; an
        // accessible name cannot rely on position, so it says the scope in
        // words either way.
        aria-label={isSpace ? "New space" : `New tab in ${where}`}
      >
        {variant === "row"
          ? <><span aria-hidden="true">+</span> New tab</>
          : <span aria-hidden="true">+</span>}
      </SheetTrigger>}
      {/* The home-indicator inset is in this rule's own padding-bottom, not a
          second class beside it: two rules at equal specificity setting
          padding-bottom is how that inset gets silently dropped. */}
      {/* `showCloseButton={false}` for the reason `RowActions` spells out at
          its own `SheetContent`: shadcn's default is a 16px unsized X, and
          Cancel, Escape and the scrim already close this. */}
      <SheetContent side="bottom" className="row-actions-sheet create-sheet" showCloseButton={false}>
        <SheetHeader className="row-actions-head">
          <SheetTitle className="row-actions-title">{title}</SheetTitle>
          <SheetDescription className="row-actions-scope">
            {isSpace
              ? "A new space, with one tab and one pane in it."
              : "A new tab in this space, with one pane in it."}
          </SheetDescription>
        </SheetHeader>

        {error !== null && <p className="error" role="alert">{error}</p>}

        <form
          className="create-form"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          <label>
            {/* In quick mode this ONE field names both. `name` is already
                derived from `label` for a space create (see `nameSource`), so
                the agent field below is a view of what was typed here — and a
                second box showing a slug of the box above it is not a
                decision, it is a repetition. Labelled for what it makes rather
                than for the record it makes it in. */}
            <span>{quick ? "Name" : isSpace ? "Space name" : "Tab name"}</span>
            <input
              type="text"
              data-field="label"
              value={label}
              autoComplete="off"
              placeholder={`herdr names the ${what} if you leave this blank`}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>

          {/* Hidden in quick mode: the dial's entry IS this answer. Still
              RENDERED in the normal flow, where nothing has been asked yet. */}
          {!quick && <label>
            <span>Start</span>
            {/* The installed kinds, plus a plain shell. Both are wanted: a
                shell is genuinely usable now that §16.3 gave it input, and it
                is the DEFAULT because starting a harness spends real tokens —
                a create that costs money must be asked for. */}
            <select
              data-field="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value={SHELL}>plain shell — no agent</option>
              {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>}

          {/* Hidden in quick mode: `name` is derived from the one name field
              above, so this would be a second box showing a slug of the first.
              It stays in the normal flow, where the space and the agent are
              genuinely two names an operator may want to differ. */}
          {!quick && kind !== SHELL && (
            <label>
              <span>Agent name</span>
              {/* Pre-filled and editable. Pre-filled from the SPACE's label,
                  slugified, because that is what herdr writes itself (§14.7);
                  editable because the operator may be starting a second agent
                  in a space that already has one. */}
              <input
                type="text"
                data-field="name"
                value={name}
                autoComplete="off"
                onChange={(e) => { setNameEdited(true); setNameDraft(e.target.value); }}
              />
            </label>
          )}

          <label>
            <span>Folder</span>
            <input
              type="text"
              data-field="cwd"
              value={cwd}
              autoComplete="off"
              spellCheck={false}
              list={cwdListId}
              placeholder={isSpace ? "herdr's default" : "the space's folder"}
              onChange={(e) => { setCwdEdited(true); setCwdDraft(e.target.value); }}
            />
          </label>
          {/* Quick picks BEFORE free text is typed, from the cwds already in
              the tree (§9.3). Buttons, not a hover menu and not a datalist
              alone: a datalist is invisible on touch until the field is
              focused, and a control you cannot see is the affordance the UI
              rules ban. The datalist is offered as well, for a keyboard. */}
          {cwds.length > 0 && (
            <div className="create-cwds" role="group" aria-label="Folders already in use">
              {cwds.map((c) => (
                <button
                  key={c}
                  type="button"
                  data-cwd-pick={c}
                  aria-pressed={cwd === c}
                  onClick={() => { setCwdEdited(true); setCwdDraft(c); }}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <datalist id={cwdListId}>
            {cwds.map((c) => <option key={c} value={c} />)}
          </datalist>

          <div className="row-actions-row">
            <button type="button" onClick={() => show(false)}>Cancel</button>
            <button
              type="submit"
              data-create-submit
              disabled={busy || unnamed}
              // Keeps focus in the input for the length of the tap — see
              // AgentTerminal's Send for the phone report behind this: a
              // pointerdown that blurs the input dismisses the keyboard, the
              // layout reflows, and the button moves out from under the finger
              // before the click lands.
              onPointerDown={(e) => { e.preventDefault(); }}
            >
              {kind === SHELL ? `Create ${what}` : `Create ${what} and start ${kind}`}
            </button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
