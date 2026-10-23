import { VERSION } from "@server/version";

/**
 * The MCP wire protocol, as much of it as the bridge needs: JSON-RPC 2.0 over
 * one POST, answered with plain JSON.
 *
 * Hand-written rather than the SDK because the bridge is stateless and never
 * streams — a wait is capped below Cloudflare's idle cutoff, so no response
 * needs SSE — and the four methods below are the whole surface. A dependency
 * the compiled binary carries for that would be weight with nothing to do.
 */

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface ToolDef {
  name: string;
  /** Read by the remote model, so it states the rules, not just the purpose. */
  description: string;
  inputSchema: object;
  call(args: Record<string, unknown>): Promise<ToolResult>;
}

export const SERVER_INFO = { name: "paddock", version: VERSION };

/** Newest first; the first is the answer to a version this list lacks. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;

type Id = string | number | null;

const ok = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One JSON-RPC message in, the response body out, or null for a notification. */
export async function handleRpc(msg: unknown, tools: readonly ToolDef[]): Promise<object | null> {
  if (!isRecord(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    // Batches land here too: an array is not a record. v1 is unbatched.
    return fail(null, -32600, "invalid request");
  }
  // No id means a notification, which is never answered.
  if (!("id" in msg)) return null;
  const id: Id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
  const params = isRecord(msg.params) ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
      return ok(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return ok(id, toolError(`unknown tool: ${String(params.name)}`));
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        const r = await tool.call(args);
        return ok(id, r.ok
          ? { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] }
          : toolError(r.error));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`mcp: ${tool.name} threw: ${detail}`);
        return ok(id, toolError(detail));
      }
    }
    default:
      return fail(id, -32601, `method not found: ${msg.method}`);
  }
}

function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}
