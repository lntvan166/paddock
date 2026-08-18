import { useEffect, useState } from "react";
import { answerWithKey, answerWithText, fetchOutput, fetchPrompt } from "@web/api";
import type { ActionResult, Agent, ParsedPrompt, PromptOption } from "@shared/types";

/** Pure, and exported so the label-verbatim rule is testable without a DOM. */
export function optionButtonsFor(prompt: ParsedPrompt): PromptOption[] {
  return prompt.options ?? [];
}

/**
 * Anything the operator produced under one particular prompt — a typed reply,
 * or the result of answering — carrying the prompt it belongs to.
 *
 * `promptSeq` counts prompts loaded into this sheet, so it changes exactly
 * when the question on screen does. Tagging is what keeps feedback attributed
 * correctly across time, the axis the per-agent `key` in `App.tsx` does not
 * cover: answer prompt A, the agent works, the agent hits prompt B — without
 * this, A's "Sent." and A's typed reply would still be sitting under B's
 * question.
 */
export interface Tagged<T> {
  value: T;
  promptSeq: number;
}

/**
 * The tagged value, but only while it still belongs to the prompt on screen.
 *
 * This is deliberately a filter at RENDER time rather than a reset when a new
 * prompt arrives: an in-flight answer can resolve after the next prompt has
 * already loaded, and a reset cannot un-write that late `setState` — a filter
 * simply never shows it. It also gives the guarantee its exact shape: the
 * prompt and its feedback are updated by the same counter, so they can never
 * be from different prompts.
 */
export function currentOnly<T>(tagged: Tagged<T> | null, promptSeq: number): T | null {
  return tagged && tagged.promptSeq === promptSeq ? tagged.value : null;
}

/** `fetchOutput`/`fetchPrompt` reject on a non-2xx response (server `detail`
 * in the message) — resolving with a lying shape was the bug that fix
 * replaced. `String(err)` on an Error gives "Error: message"; this keeps just
 * the message so the operator sees the server's actual reason. */
function messageFrom(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface AgentDetailViewProps {
  agent: Agent;
  output: string[];
  outputError: string | null;
  /** A refresh is in flight; the control says so and cannot be double-fired. */
  refreshing: boolean;
  prompt: ParsedPrompt | null;
  promptError: string | null;
  /** Which prompt the sheet is currently showing. See `Tagged`. */
  promptSeq: number;
  feedback: Tagged<ActionResult> | null;
  reply: Tagged<string> | null;
  busy: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onReplyChange: (text: string) => void;
  onAnswerKey: (key: string) => void;
  onSubmitReply: (text: string) => void;
}

/**
 * The sheet's markup, with every piece of state as a prop and no hooks.
 *
 * Split from the stateful component below so the rendered output is testable
 * without a DOM: `renderToStaticMarkup` can put this view in any state that
 * matters — a result under a superseded prompt, a result on an agent that has
 * already left `blocked` — which a component owning its own state cannot be
 * placed in from a test.
 */
export function AgentDetailView({
  agent, output, outputError, refreshing, prompt, promptError,
  promptSeq, feedback, reply, busy,
  onClose, onRefresh, onReplyChange, onAnswerKey, onSubmitReply,
}: AgentDetailViewProps) {
  const options = prompt ? optionButtonsFor(prompt) : [];
  // Feedback and the typed reply are shown only while they still belong to
  // the prompt on screen.
  const result = currentOnly(feedback, promptSeq);
  const replyText = currentOnly(reply, promptSeq) ?? "";

  return (
    <aside className="detail" role="dialog" aria-label={`${agent.name} detail`}>
      <header>
        <h2>{agent.name}</h2>
        <p>{agent.task}</p>
        <div className="controls">
          {/* Spec §5's explicit refresh control. Output is fetched when the
              sheet opens and on a state change — so without this, an idle or
              working agent's transcript is frozen at the moment it opened.
              Never streamed: continuously pushing several terminals over a
              ~250 ms link is the one way to make paddock genuinely slow. */}
          <button type="button" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </header>

      {/* A failed read is surfaced right where the output would have been —
          never a silently blank pane, on the initial load and on a refresh
          alike. */}
      {outputError ? (
        <p className="warn" role="alert">Could not load output: {outputError}</p>
      ) : (
        <pre className="output">{output.join("\n")}</pre>
      )}

      {agent.state === "blocked" && (
        <section className="answer">
          {promptError && (
            <p className="warn" role="alert">Could not load prompt options: {promptError}</p>
          )}
          {prompt?.question && <p className="question">{prompt.question}</p>}

          {/* One button per REAL option, in the agent's order, with the agent's
              exact label. The container scrolls; labels wrap. Truncating one
              would reintroduce the ambiguity this design exists to avoid — a
              clipped "Yes, and always allow acce…" is unreadable as a choice. */}
          <div className="options">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                disabled={busy}
                aria-pressed={o.selected}
                onClick={() => onAnswerKey(o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>

          {/* Always offered, even when options parsed, and even when the
              prompt fetch itself failed: the operator may want to say
              something no option covers, or the only thing on screen is raw
              output plus this box. paddock never invents a default action. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (replyText.trim()) onSubmitReply(replyText.trim());
            }}
          >
            <label htmlFor="reply">Reply</label>
            <input
              id="reply" value={replyText} disabled={busy}
              onChange={(e) => onReplyChange(e.target.value)}
              placeholder="Type an answer instead"
            />
            <button type="submit" disabled={busy || !replyText.trim()}>Send</button>
          </form>
        </section>
      )}

      {/* OUTSIDE the blocked-only section, deliberately. A successful answer's
          defining outcome is that the agent LEAVES `blocked` — so nested in
          there, "Sent." unmounted with the section the moment the delta it
          caused arrived, and at best flashed for the ~100 ms of hub
          coalescing. Spec §8 requires every action to report explicit success
          or failure; this is the seam it used to be dropped at. */}
      {result && (
        <p className={result.ok ? "ok" : "warn"} role="status">
          {result.ok ? "Sent." : (result.detail ?? "Failed.")}
        </p>
      )}
    </aside>
  );
}

export function AgentDetail({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [output, setOutput] = useState<string[]>([]);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [promptSeq, setPromptSeq] = useState(0);
  const [feedback, setFeedback] = useState<Tagged<ActionResult> | null>(null);
  const [reply, setReply] = useState<Tagged<string> | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadOutput(accept: () => boolean) {
    try {
      const o = await fetchOutput(agent.agentId);
      // This view never sends `since`, so the server always returns a screen;
      // the guard is here because the CONTRACT allows "unchanged" and a cast
      // would be a lie waiting to become a blank pane.
      if (accept() && !o.unchanged) {
        setOutput(o.lines);
        setOutputError(null);
      }
      // A rejected read must not leave the pane silently blank — that is
      // exactly the failure mode the read-rejection fix exists to prevent.
    } catch (err: unknown) {
      if (accept()) setOutputError(messageFrom(err));
    }
  }

  useEffect(() => {
    let live = true;
    setOutput([]);
    setOutputError(null);
    void loadOutput(() => live);

    if (agent.state === "blocked") {
      // A new prompt is on screen from here on: bump the counter so anything
      // tagged with the previous one stops being shown. `busy` is not tagged
      // (a disabled button is not feedback), but it is released here so an
      // answer whose request never settles cannot leave the next prompt's
      // buttons dead.
      setPromptSeq((n) => n + 1);
      setBusy(false);
      setPrompt(null);
      setPromptError(null);
      fetchPrompt(agent.agentId)
        .then((p) => { if (live) setPrompt(p); })
        .catch((err: unknown) => { if (live) setPromptError(messageFrom(err)); });
    }

    return () => { live = false; };
    // `loadOutput` reads `agent.agentId` and nothing else, and `App.tsx`
    // remounts this component per agent, so it cannot go stale within one
    // instance — the two values below are the whole dependency set.
  }, [agent.agentId, agent.state]);

  /**
   * Re-run the output fetch on demand. Deliberately does NOT refetch the
   * prompt: the options only change when the agent re-enters `blocked`, which
   * already refetches them and bumps `promptSeq` — refetching them here would
   * be able to replace the question on screen without moving the counter that
   * keeps feedback attributed to it.
   */
  async function refresh() {
    setRefreshing(true);
    await loadOutput(() => true);
    setRefreshing(false);
  }

  async function run(action: () => Promise<ActionResult>) {
    // Captured at send time. If the agent reaches a NEW prompt before this
    // resolves, the result is tagged with the prompt it actually answered and
    // the view stops showing it.
    const seq = promptSeq;
    setBusy(true);
    const result = await action();
    setFeedback({ value: result, promptSeq: seq });
    setBusy(false);
  }

  return (
    <AgentDetailView
      agent={agent}
      output={output}
      outputError={outputError}
      refreshing={refreshing}
      prompt={prompt}
      promptError={promptError}
      promptSeq={promptSeq}
      feedback={feedback}
      reply={reply}
      busy={busy}
      onClose={onClose}
      onRefresh={() => void refresh()}
      onReplyChange={(text) => setReply({ value: text, promptSeq })}
      onAnswerKey={(key) => void run(() => answerWithKey(agent.agentId, key))}
      onSubmitReply={(text) => void run(() => answerWithText(agent.agentId, text))}
    />
  );
}
