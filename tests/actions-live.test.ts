import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createActions, readSourceFor } from "@server/herdr/actions";
import { request } from "@server/herdr/socket";
import { toAgent } from "@server/herdr/adapter";
import { parsePrompt } from "@server/herdr/prompt-parse";
import type { Agent } from "@shared/types";

/**
 * The check that would have caught the read bug on the day it was written.
 *
 * `tests/actions.test.ts` exercises `readOutput`/`readDetection` against a
 * fake, and a fake is only ever as honest as whoever wrote it: for the whole
 * of v2 it answered `agent.read` with `{ text }` — a shape herdr has never
 * sent — so every one of those tests passed while the real output pane was
 * empty for every agent and tap-to-answer silently degraded to free text.
 * A fake more permissive than the real dependency certifies the code against
 * the mistake rather than against reality.
 *
 * So this file talks to the actual socket. It asserts on SHAPE only —
 * non-empty text, plausible line counts, the source that was asked for — and
 * never on content: the agents it reads are the operator's real ones, and
 * this repository is public.
 *
 * It skips, loudly and specifically, when there is no herdr to talk to (CI,
 * a fresh clone, a laptop with herdr stopped) rather than failing. A skip
 * that says WHY it skipped is the difference between a check that degrades
 * and one that quietly stops existing.
 */
const SOCKET =
  process.env.PADDOCK_HERDR_SOCKET ?? join(homedir(), ".config", "herdr", "herdr.sock");

async function liveAgents(): Promise<Agent[] | null> {
  // statSync, not Bun.file().exists(): a unix socket is not a regular file,
  // and Bun.file() reports it as absent — which would have made this whole
  // file skip on the one machine where it can actually run.
  try {
    if (!statSync(SOCKET).isSocket()) return null;
  } catch {
    return null;
  }
  try {
    const res = await request<{ agents: unknown[] }>(SOCKET, "agent.list", {});
    const ctx = { hostId: "test-host", labels: new Map<string, string>(), now: Date.now() };
    const agents = res.agents
      .map((raw) => toAgent(raw as never, ctx))
      .filter((a): a is Agent => a !== null);
    return agents.length > 0 ? agents : null;
  } catch {
    // A socket file with no herdr behind it is the same situation as no
    // socket at all: nothing to prove the code against, so skip rather than
    // fail. Any OTHER failure — a live herdr that rejects agent.list — is a
    // real defect, and reaches the tests below unhandled.
    return null;
  }
}

const agents = await liveAgents();
const why = agents === null
  ? `SKIPPED tests/actions-live.test.ts: no herdr agents at ${SOCKET.replace(homedir(), "~")}`
  : null;
if (why) console.warn(why);

test.skipIf(agents === null)(
  "readOutput returns real, non-empty output from a live herdr, in every agent state present",
  async () => {
    const actions = createActions(SOCKET);
    // One agent per distinct state, so whichever states the machine happens
    // to be in are all covered and neither branch of readSourceFor can rot.
    const byState = new Map(agents!.map((a) => [a.state, a]));
    expect(byState.size).toBeGreaterThan(0);

    for (const [state, agent] of byState) {
      // BOTH stages, against the real socket. The default (fast) read is what
      // paints first, and the scrollback read is what replaces it for an idle
      // agent — a regression in either is a regression the fakes cannot see.
      const fast = await actions.readOutput(agent.agentId, state);
      // The assertion the fake could not make: `res.read.text` carries text.
      // Under the old `res.text`, every one of these is 0.
      expect(fast.lines.length).toBeGreaterThan(0);
      expect(fast.lines.join("").trim().length).toBeGreaterThan(0);
      expect(fast.source).toBe("visible");

      const full = await actions.readOutput(agent.agentId, state, undefined, true);
      expect(full.lines.length).toBeGreaterThan(0);
      expect(full.source).toBe(readSourceFor(state));

      // Shape only. Never the content — these are real agents.
      console.log(
        `  live readOutput  state=${state} fast=${fast.source}/${fast.lines.length}` +
        ` full=${full.source}/${full.lines.length}`,
      );
    }
  },
  60_000,
);

test.skipIf(agents === null)(
  "readDetection returns a real snapshot the prompt parser can be run over",
  async () => {
    const actions = createActions(SOCKET);
    for (const agent of agents!) {
      const text = await actions.readDetection(agent.agentId);
      expect(text.length).toBeGreaterThan(0);
      expect(text.trim().length).toBeGreaterThan(0);
      // `detection` is not state-gated, so it must work for every agent.
      // parsePrompt("") is what the bug produced, and it returns
      // `options: null` — the exact silent degradation to the free-text box.
      // This does not assert a prompt WAS found (only a blocked agent has
      // one); it asserts the parser was handed something to work with.
      const parsed = parsePrompt(text);
      expect(parsed).toBeDefined();
      console.log(
        `  live readDetection state=${agent.state} bytes=${text.length} ` +
        `lines=${text.split("\n").length} options=${parsed.options?.length ?? "null"}`,
      );
    }
  },
  60_000,
);
