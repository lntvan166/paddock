import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentDetailView, currentOnly, type AgentDetailViewProps } from "@web/components/AgentDetail";
import type { ActionResult, Agent } from "@shared/types";

// Rendered rather than asserted on a helper: the defects these cover were
// both about WHERE a piece of markup sits, which a pure predicate cannot see.
// `renderToStaticMarkup` needs no DOM, so this costs no new test dependency.

const NOW = 1_700_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "schema-migration",
    task: "Add the tenant column", state: "blocked", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project",
    stateSince: NOW, updatedAt: NOW, acknowledgedAt: null, ...over,
  };
}

function view(over: Partial<AgentDetailViewProps> = {}): string {
  const props: AgentDetailViewProps = {
    agent: agent(),
    output: ["running tests"],
    outputError: null,
    refreshing: false,
    prompt: { question: "Do you want to proceed?", raw: "", options: [
      { key: "1", label: "Yes", selected: true },
      { key: "2", label: "No", selected: false },
    ] },
    promptError: null,
    promptSeq: 1,
    feedback: null,
    reply: null,
    busy: false,
    onClose: () => {},
    onRefresh: () => {},
    onReplyChange: () => {},
    onAnswerKey: () => {},
    onSubmitReply: () => {},
    ...over,
  };
  return renderToStaticMarkup(<AgentDetailView {...props} />);
}

const sent = (promptSeq: number): { value: ActionResult; promptSeq: number } => ({
  value: { ok: true },
  promptSeq,
});

// FINDING 4. The success confirmation used to live inside the blocked-only
// section — but a successful answer's defining outcome is that the agent
// LEAVES `blocked`, so the delta it caused unmounted the section and took
// "Sent." with it. Best case it flashed for the ~100 ms of hub coalescing.
test("the result survives the state change the action itself caused", () => {
  const markup = view({ agent: agent({ state: "working" }), feedback: sent(1) });
  expect(markup).toContain("Sent.");
  // ...and the answer section really is gone, so this is not passing because
  // the agent still counts as blocked.
  expect(markup).not.toContain("Do you want to proceed?");
});

test("a refusal survives it too, arriving alongside the state change that caused it", () => {
  const markup = view({
    agent: agent({ state: "idle" }),
    feedback: { value: { ok: false, detail: "agent is idle, no longer blocked" }, promptSeq: 1 },
  });
  expect(markup).toContain("agent is idle, no longer blocked");
});

// FINDING 5. Identity was fixed by the per-agent `key` in App.tsx; this is the
// same misattribution one axis over — the SAME agent, a LATER prompt.
test("feedback from an answered prompt is never shown under the next one", () => {
  const markup = view({ promptSeq: 2, feedback: sent(1) });
  expect(markup).not.toContain("Sent.");
});

test("a reply typed for one prompt is never left in the box under the next one", () => {
  const stale = { value: "no, run the tests first", promptSeq: 1 };
  expect(view({ promptSeq: 1, reply: stale })).toContain("no, run the tests first");
  expect(view({ promptSeq: 2, reply: stale })).not.toContain("no, run the tests first");
});

test("feedback for the prompt on screen is shown", () => {
  expect(view({ promptSeq: 2, feedback: sent(2) })).toContain("Sent.");
});

test("currentOnly keeps a value only while its prompt is the one on screen", () => {
  expect(currentOnly({ value: "x", promptSeq: 3 }, 3)).toBe("x");
  expect(currentOnly({ value: "x", promptSeq: 3 }, 4)).toBeNull();
  expect(currentOnly(null, 3)).toBeNull();
});

// FINDING 3. Spec §5 calls for an explicit refresh control; the only refetch
// trigger was the effect's dependency array, so an idle or working agent's
// output was frozen at the moment the sheet opened.
test("an explicit refresh control is offered", () => {
  expect(view()).toContain("Refresh");
});

test("the refresh control reports that it is running and cannot be double-fired", () => {
  const markup = view({ refreshing: true });
  expect(markup).toContain("Refreshing");
  expect(markup).toMatch(/<button[^>]*disabled[^>]*>Refreshing/);
});

// A refresh that fails must show why, exactly as the initial load does.
test("a failed read is surfaced where the output would have been", () => {
  const markup = view({ outputError: "agent_not_idle" });
  expect(markup).toContain("Could not load output: agent_not_idle");
  expect(markup).not.toContain("running tests");
});

test("option labels reach the markup verbatim", () => {
  const long = "Yes, and always allow access to project/ from this project";
  const markup = view({
    prompt: { question: "Proceed?", raw: "", options: [
      { key: "1", label: long, selected: false },
      { key: "2", label: "No", selected: false },
    ] },
  });
  expect(markup).toContain(long);
});
