import { expect, test } from "bun:test";
import { MAX_CLIENT_FRAME, parseClientMessage } from "@server/ws/serve";

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
