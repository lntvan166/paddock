import { useEffect, useState } from "react";
import { answerWithKey, answerWithText, fetchOutput, fetchPrompt } from "@web/api";
import type { ActionResult, Agent, ParsedPrompt, PromptOption } from "@shared/types";

/** Pure, and exported so the label-verbatim rule is testable without a DOM. */
export function optionButtonsFor(prompt: ParsedPrompt): PromptOption[] {
  return prompt.options ?? [];
}

/** `fetchOutput`/`fetchPrompt` reject on a non-2xx response (server `detail`
 * in the message) — resolving with a lying shape was the bug that fix
 * replaced. `String(err)` on an Error gives "Error: message"; this keeps just
 * the message so the operator sees the server's actual reason. */
function messageFrom(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AgentDetail({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [output, setOutput] = useState<string[]>([]);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setOutput([]);
    setOutputError(null);
    fetchOutput(agent.agentId)
      .then((o) => { if (live) setOutput(o.lines); })
      // A rejected read must not leave the pane silently blank — that is
      // exactly the failure mode the read-rejection fix exists to prevent.
      .catch((err: unknown) => { if (live) setOutputError(messageFrom(err)); });

    if (agent.state === "blocked") {
      setPrompt(null);
      setPromptError(null);
      fetchPrompt(agent.agentId)
        .then((p) => { if (live) setPrompt(p); })
        .catch((err: unknown) => { if (live) setPromptError(messageFrom(err)); });
    }

    return () => { live = false; };
  }, [agent.agentId, agent.state]);

  async function run(action: () => Promise<ActionResult>) {
    setBusy(true);
    setResult(await action());
    setBusy(false);
  }

  const options = prompt ? optionButtonsFor(prompt) : [];

  return (
    <aside className="detail" role="dialog" aria-label={`${agent.name} detail`}>
      <header>
        <h2>{agent.name}</h2>
        <p>{agent.task}</p>
        <button type="button" onClick={onClose}>Close</button>
      </header>

      {/* A failed read is surfaced right where the output would have been —
          never a silently blank pane. */}
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
                onClick={() => void run(() => answerWithKey(agent.agentId, o.key))}
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
              if (reply.trim()) void run(() => answerWithText(agent.agentId, reply.trim()));
            }}
          >
            <label htmlFor="reply">Reply</label>
            <input
              id="reply" value={reply} disabled={busy}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Type an answer instead"
            />
            <button type="submit" disabled={busy || !reply.trim()}>Send</button>
          </form>

          {result && (
            <p className={result.ok ? "ok" : "warn"} role="status">
              {result.ok ? "Sent." : (result.detail ?? "Failed.")}
            </p>
          )}
        </section>
      )}
    </aside>
  );
}
