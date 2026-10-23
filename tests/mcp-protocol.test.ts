import { expect, test } from "bun:test";
import { handleRpc, PROTOCOL_VERSIONS, SERVER_INFO, type ToolDef } from "@server/mcp/protocol";

const echo: ToolDef = {
  name: "echo", description: "Echo the input.", inputSchema: { type: "object" },
  call: async (args) => ({ ok: true, data: { got: args } }),
};
const refuses: ToolDef = {
  name: "refuses", description: "Always refuses.", inputSchema: { type: "object" },
  call: async () => ({ ok: false, error: "agent is waiting on a prompt" }),
};
const throws: ToolDef = {
  name: "throws", description: "Always throws.", inputSchema: { type: "object" },
  call: async () => { throw new Error("the socket refused"); },
};
const tools = [echo, refuses, throws];

const rpc = (method: string, params?: object, id: number | null = 1) =>
  ({ jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(id === null ? {} : { id }) });

test("initialize echoes a supported version", async () => {
  const r = await handleRpc(rpc("initialize", { protocolVersion: "2025-03-26" }), tools) as any;
  expect(r).toEqual({
    jsonrpc: "2.0", id: 1,
    result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: SERVER_INFO },
  });
});

test("initialize falls back for an unknown version", async () => {
  const r = await handleRpc(rpc("initialize", { protocolVersion: "1999-01-01" }), tools) as any;
  expect(r.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
});

test("a notification returns null", async () => {
  expect(await handleRpc(rpc("notifications/initialized", undefined, null), tools)).toBeNull();
});

test("ping answers an empty result", async () => {
  expect(await handleRpc(rpc("ping"), tools)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
});

test("tools/list shape", async () => {
  const r = await handleRpc(rpc("tools/list"), tools) as any;
  expect(r.result.tools).toEqual([
    { name: "echo", description: "Echo the input.", inputSchema: { type: "object" } },
    { name: "refuses", description: "Always refuses.", inputSchema: { type: "object" } },
    { name: "throws", description: "Always throws.", inputSchema: { type: "object" } },
  ]);
});

test("tools/call ok returns the data as JSON text", async () => {
  const r = await handleRpc(rpc("tools/call", { name: "echo", arguments: { id: "w1:p1" } }), tools) as any;
  expect(r.result.isError).toBeUndefined();
  expect(JSON.parse(r.result.content[0].text)).toEqual({ got: { id: "w1:p1" } });
});

test("a tool error is isError with its reason", async () => {
  const r = await handleRpc(rpc("tools/call", { name: "refuses", arguments: {} }), tools) as any;
  expect(r.result).toEqual({ content: [{ type: "text", text: "agent is waiting on a prompt" }], isError: true });
});

test("a thrown tool error is isError, not a protocol error", async () => {
  const r = await handleRpc(rpc("tools/call", { name: "throws", arguments: {} }), tools) as any;
  expect(r.result.isError).toBe(true);
  expect(r.result.content[0].text).toBe("the socket refused");
});

test("an unknown tool is isError", async () => {
  const r = await handleRpc(rpc("tools/call", { name: "start_agent", arguments: {} }), tools) as any;
  expect(r.result.isError).toBe(true);
  expect(r.result.content[0].text).toContain("start_agent");
});

test("missing arguments are treated as an empty object", async () => {
  const r = await handleRpc(rpc("tools/call", { name: "echo" }), tools) as any;
  expect(JSON.parse(r.result.content[0].text)).toEqual({ got: {} });
});

test("an unknown method is -32601", async () => {
  const r = await handleRpc(rpc("resources/list"), tools) as any;
  expect(r.error.code).toBe(-32601);
  expect(r.id).toBe(1);
});

test("an invalid request is -32600", async () => {
  for (const bad of [null, "x", 3, { method: "ping", id: 1 }, { jsonrpc: "1.0", method: "ping", id: 1 }]) {
    const r = await handleRpc(bad, tools) as any;
    expect(r.error.code).toBe(-32600);
    expect(r.id).toBeNull();
  }
});

test("a batch is refused with -32600", async () => {
  const r = await handleRpc([rpc("ping")], tools) as any;
  expect(r.error.code).toBe(-32600);
});
