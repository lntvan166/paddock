import type { AgentCommand } from "@shared/types";

/**
 * The reply field's command list.
 *
 * Hook-free and presentational, the same split `AgentDetail` uses: every
 * decision about WHEN it appears belongs to the caller, so this file can be
 * rendered from a test with no effects to settle.
 *
 * It sits directly above the field it fills, so what is being chosen and where
 * it lands are adjacent. There is no dismiss control: the list closes when the
 * field stops being a command, which the operator does by typing — the same
 * reason picking a row appends a trailing space.
 */
export function CommandList({ matches, exhausted, onPick, busy = false }: {
  /** Already filtered and ranked by the caller (`web/commands.ts`). */
  matches: readonly AgentCommand[];
  /**
   * Whether the PROJECT has no commands at all, as opposed to the term
   * matching none of them.
   *
   * Two different sentences, because they send the operator to different
   * places: one means this repository declares nothing, the other means to try
   * a different word. Collapsing them into "nothing here" would hide which.
   */
  exhausted: boolean;
  onPick: (command: AgentCommand) => void;
  busy?: boolean;
}) {
  return (
    <div className="term-cmds" role="listbox" aria-label="Project commands">
      {matches.length === 0 ? (
        // Said out loud rather than rendered as nothing. An empty list that
        // simply fails to appear is indistinguishable from a broken feature,
        // and a project with no `.claude` is the common case by a wide margin.
        <p className="term-cmd-empty" role="status">
          {exhausted
            ? "No commands in this project"
            : "No match — the harness's own commands are not listed"}
        </p>
      ) : (
        matches.map((c) => (
          <button
            key={c.command}
            type="button"
            className="term-cmd"
            role="option"
            aria-selected="false"
            disabled={busy}
            // Same reasoning as the Send button's: a tap begins with a
            // pointerdown, which moves focus off the input and lets iOS
            // dismiss the keyboard — the layout then reflows upward and this
            // row is no longer under the finger when the tap completes.
            onPointerDown={(e) => { e.preventDefault(); }}
            onClick={() => onPick(c)}
          >
            <span className="term-cmd-top">
              <span className="term-cmd-name">{c.command}</span>
              <span className="term-cmd-src" data-kind={c.source}>{c.source}</span>
            </span>
            {c.description && <span className="term-cmd-desc">{c.description}</span>}
          </button>
        ))
      )}
    </div>
  );
}
