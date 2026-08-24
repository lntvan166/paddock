import "./support/dom";

import { expect, test } from "bun:test";

/**
 * The prompt options carry the agent's OWN digit as a badge.
 *
 * This is not a keystroke paddock guessed. `ParsedPrompt.option.key` is the
 * digit herdr read off the agent's screen, and `answerWithKey` already sends
 * exactly that value — so the badge shows the key that will actually be sent.
 * CLAUDE.md's rule is "never guess a keystroke for a blocked agent … render
 * the prompt's real options with their real labels"; showing the real digit
 * beside the real label is inside that rule, and a mislabelled Approve button
 * is precisely what it forbids.
 *
 * Asserted against the source rather than a render, because mounting
 * `AgentTerminal` needs a live agent, a fetch stub and a screen — and what
 * matters here is that the badge is fed from `o.key` rather than from an index
 * or a hardcoded sequence. A badge showing `1., 2., 3.` regardless of what the
 * agent said would look right and send the wrong key.
 */
const src = await Bun.file("src/web/components/AgentTerminal.tsx").text();

test("the option badge is fed from the agent's own digit", () => {
  const block = src.slice(src.indexOf('className="term-options"'));
  const option = block.slice(0, block.indexOf("</div>"));
  expect(option).toContain("term-option-key");
  // The badge renders o.key — the digit herdr parsed — not a loop index.
  expect(option).toMatch(/term-option-key[^>]*>\s*\{o\.key\}/);
  expect(option).not.toMatch(/term-option-key[^>]*>\s*\{i\s*\+\s*1\}/);
});

test("the key sent is the same value the badge shows", () => {
  // Two reads of `o.key`: one painted, one sent. If they ever diverge the
  // badge becomes a lie about what pressing it does.
  const block = src.slice(src.indexOf('className="term-options"'));
  const option = block.slice(0, block.indexOf("</div>"));
  expect(option).toContain("answerWithKey(agent.agentId, o.key)");
});

test("the option's label is still rendered verbatim", () => {
  // The badge is additive. The label is the agent's own text and must not be
  // reformatted, truncated or replaced by the digit.
  const block = src.slice(src.indexOf('className="term-options"'));
  const option = block.slice(0, block.indexOf("</div>"));
  expect(option).toContain("{o.label}");
});
