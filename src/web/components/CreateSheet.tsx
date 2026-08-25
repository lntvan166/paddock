import { useEffect, useId, useRef, useState } from "react";
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
}) {
  const [open, setOpen] = useState(false);
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

  const isSpace = target.kind === "space";
  const what = isSpace ? "space" : "tab";
  /** Where this tab is going, for the heading and the accessible name. The id
   *  IS the honest answer for an unnamed space — it is what the row shows, and
   *  the sheet must agree with the row it opened from. */
  const where = isSpace ? "" : target.spaceLabel ?? target.spaceId;
  const title = isSpace ? "New space" : `New tab in ${where}`;

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
    setOpen(next);
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
      <SheetTrigger
        data-create={what}
        className="create-btn"
        // Position carries the scope on screen; an accessible name cannot rely
        // on position, so it says the scope in words.
        aria-label={isSpace ? "New space" : `New tab in ${where}`}
      >
        <span aria-hidden="true">+</span>
      </SheetTrigger>
      {/* The home-indicator inset is in this rule's own padding-bottom, not a
          second class beside it: two rules at equal specificity setting
          padding-bottom is how that inset gets silently dropped. */}
      <SheetContent side="bottom" className="row-actions-sheet create-sheet">
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
            <span>{isSpace ? "Space name" : "Tab name"}</span>
            <input
              type="text"
              data-field="label"
              value={label}
              autoComplete="off"
              placeholder={`herdr names the ${what} if you leave this blank`}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>

          <label>
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
          </label>

          {kind !== SHELL && (
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
            <button type="submit" data-create-submit disabled={busy || unnamed}>
              {kind === SHELL ? `Create ${what}` : `Create ${what} and start ${kind}`}
            </button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
