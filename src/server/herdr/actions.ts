import { request } from "@server/herdr/socket";
import type { AgentState } from "@shared/types";

export type ReadSource = "detection" | "visible" | "recent_unwrapped";

/** Default line budget for an on-demand read. Output is never streamed. */
export const DEFAULT_READ_LINES = 120;

/**
 * Pick the read source by agent state.
 *
 * `recent` and `recent_unwrapped` return `agent_not_idle` on a BLOCKED agent:
 * its prompt renders on the terminal's alternate screen, whose history "can
 * only be captured by scrolling while idle" — herdr's own error recommends
 * `visible`. This bites precisely on the agents most worth reading, so the
 * choice is state-driven rather than a preference.
 */
export function readSourceFor(state: AgentState): ReadSource {
  return state === "blocked" ? "visible" : "recent_unwrapped";
}

export interface HerdrActions {
  readOutput(target: string, state: AgentState, lines?: number): Promise<{ lines: string[]; source: ReadSource }>;
  readDetection(target: string): Promise<string>;
  sendOptionKey(target: string, key: string): Promise<void>;
  sendReply(target: string, text: string): Promise<void>;
  waitUntilUnblocked(target: string, timeoutMs?: number): Promise<void>;
}

/** Binds the socket path once so routes can take an injectable object. */
export function createActions(socketPath: string): HerdrActions {
  return {
    async readOutput(target, state, lines = DEFAULT_READ_LINES) {
      const source = readSourceFor(state);
      const res = await request<{ text?: string }>(socketPath, "agent.read", {
        target, source, lines, format: "text", strip_ansi: true,
      });
      return { lines: (res.text ?? "").split("\n"), source };
    },

    async readDetection(target) {
      const res = await request<{ text?: string }>(socketPath, "agent.read", {
        target, source: "detection", lines: 60, format: "text", strip_ansi: true,
      });
      return res.text ?? "";
    },

    async sendOptionKey(target, key) {
      await request(socketPath, "agent.send_keys", { target, keys: [key] });
    },

    async sendReply(target, text) {
      await request(socketPath, "agent.prompt", { target, text });
    },

    async waitUntilUnblocked(target, timeoutMs = 15_000) {
      // Wait on LEAVING blocked. Declining an option settles the agent on
      // `idle`, so a `working`-only wait reports a false failure on every
      // rejection — confirmed during the probe, where answering "Yes" also
      // settled on idle once the command finished.
      await request(socketPath, "agent.wait", {
        target, until: ["working", "idle", "done"], timeout_ms: timeoutMs,
      });
    },
  };
}
