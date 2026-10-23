/**
 * Ceilings on client-supplied text, shared by `routes.ts` and the MCP bridge.
 *
 * Their own module so `mcp/` can enforce the same bounds the routes do without
 * importing `routes.ts`, which imports `mcp/`.
 */

/**
 * Ceiling on typed text. Generous for a phone reply, small enough that a
 * runaway paste cannot be forwarded into an agent's prompt wholesale.
 */
export const MAX_TEXT_LEN = 10_000;

/**
 * Characters one `/type` call may send.
 *
 * A free-text ANSWER, not a message: the reply box already exists for prose and
 * goes through `agent.prompt`. Sized so a sentence fits and a pasted file does
 * not, because every character here becomes one entry in a `send_keys` array.
 */
export const MAX_TYPE_CHARS = 200;
