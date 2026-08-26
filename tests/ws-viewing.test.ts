import { expect, test } from "bun:test";
import { hubWebSocket, MAX_CLIENT_FRAME, parseClientMessage } from "@server/ws/serve";
import type { Hub } from "@server/ws/hub";
import type { AgentStore } from "@server/state/store";
import { PresenceStore } from "@server/state/presence";

test("a valid frame parses", () => {
  expect(parseClientMessage(JSON.stringify({ type: "viewing", deviceKey: "dk", agentId: "w1:p1" })))
    .toEqual({ type: "viewing", deviceKey: "dk", agentId: "w1:p1" });
});

test("nulls are meaningful and preserved", () => {
  // deviceKey null: a browser with no subscription. agentId null: on the list,
  // or hidden. Both are statements, not absences.
  expect(parseClientMessage(JSON.stringify({ type: "viewing", deviceKey: null, agentId: null })))
    .toEqual({ type: "viewing", deviceKey: null, agentId: null });
});

test("junk returns null instead of throwing", () => {
  // This is the first untrusted input this socket has ever accepted. Throwing
  // in a Bun `message` handler drops the connection, which would make a
  // malformed frame a way to disconnect somebody's dashboard.
  for (const raw of ["", "{", "null", "[]", '"a string"', "42"]) {
    expect(parseClientMessage(raw)).toBeNull();
  }
});

test("an unknown type is ignored, not rejected loudly", () => {
  // A newer client talking to an older server degrades to no presence rather
  // than to a broken socket.
  expect(parseClientMessage(JSON.stringify({ type: "typing", agentId: "w1:p1" }))).toBeNull();
});

test("wrong field types are refused", () => {
  expect(parseClientMessage(JSON.stringify({ type: "viewing", deviceKey: 7, agentId: "w1:p1" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ type: "viewing", deviceKey: "dk", agentId: {} }))).toBeNull();
});

test("an oversized frame is refused before it is parsed", () => {
  const huge = JSON.stringify({ type: "viewing", deviceKey: "d".repeat(MAX_CLIENT_FRAME), agentId: null });
  expect(parseClientMessage(huge)).toBeNull();
});

test("a plausible frame with an implausibly long id is refused", () => {
  // A pane id is `w1:p1`. Nothing paddock issues is 300 characters, and the
  // value becomes a Map key held until the socket closes.
  expect(parseClientMessage(JSON.stringify({
    type: "viewing", deviceKey: "dk", agentId: "w".repeat(300),
  }))).toBeNull();
});

test("a non-string input is refused", () => {
  expect(parseClientMessage(undefined)).toBeNull();
  expect(parseClientMessage({ type: "viewing" })).toBeNull();
});

test("the handler carries Bun's own payload cap, not just message()'s guard", () => {
  // Without this, Bun buffers up to its 16 MB default before message() ever
  // runs to check MAX_CLIENT_FRAME — a huge frame would be fully received
  // before paddock got a chance to refuse it. Asserted on the returned
  // handler, which is what BOTH listeners' `Bun.serve` calls build their
  // `websocket` option from, so a future edit cannot drop the cap on one
  // listener and keep it on the other.
  const handler = hubWebSocket({
    hub: {} as Hub,
    hostId: "dev-box",
    store: {} as AgentStore,
    presence: {} as PresenceStore,
  });
  expect(handler.maxPayloadLength).toBe(MAX_CLIENT_FRAME);
});

/**
 * The manual two-browser check the plan called for was never actually
 * performed (see the whole-branch review). This is the cheap substitute: the
 * REAL `open`/`message`/`close` handlers `hubWebSocket` returns, driven
 * directly with a fake socket, against a REAL `PresenceStore` — so what is
 * proven is the wiring between the socket handlers and presence, not a
 * reimplementation of either. `hub` and `store` are plain stubs: nothing here
 * exercises fan-out or the agent snapshot, both already covered elsewhere
 * (`hub.test.ts`, `lifecycle-server-state.test.ts`).
 */
test("a valid frame reaches presence and viewers() sees it, and close drops it", () => {
  const presence = new PresenceStore();
  const hub = { add: () => {}, remove: () => {}, sendSnapshot: () => {} } as unknown as Hub;
  const store = { snapshot: () => [] } as unknown as AgentStore;
  const handler = hubWebSocket({ hub, hostId: "dev-box", store, presence });

  // One fake socket. `send` is never asserted on: the stub `hub` above never
  // calls `client.send`, so what matters is only that it exists as a
  // callable the real `open()` can close over.
  const ws = { data: {}, send: () => {} } as unknown as Parameters<typeof handler.message>[0];

  handler.open?.(ws);
  handler.message(ws, JSON.stringify({ type: "viewing", deviceKey: "dk-1", agentId: "w1:p1" }));
  expect(presence.viewers("w1:p1")).toEqual(new Set(["dk-1"]));

  handler.close?.(ws, 1000, "");
  expect(presence.viewers("w1:p1")).toEqual(new Set());
});

test("a frame for one agent does not appear under another", () => {
  const presence = new PresenceStore();
  const hub = { add: () => {}, remove: () => {}, sendSnapshot: () => {} } as unknown as Hub;
  const store = { snapshot: () => [] } as unknown as AgentStore;
  const handler = hubWebSocket({ hub, hostId: "dev-box", store, presence });
  const ws = { data: {}, send: () => {} } as unknown as Parameters<typeof handler.message>[0];

  handler.open?.(ws);
  handler.message(ws, JSON.stringify({ type: "viewing", deviceKey: "dk-1", agentId: "w1:p1" }));
  expect(presence.viewers("w2:p9")).toEqual(new Set());
});
