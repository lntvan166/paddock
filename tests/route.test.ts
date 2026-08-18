import { expect, test } from "bun:test";
import { agentHash, agentIdFromHash } from "@web/route";

test("an agent id round-trips through the hash", () => {
  // Agent ids are herdr pane ids and always contain a colon, which must be
  // percent-encoded or the hash is ambiguous with a future `#/agent/x/y`
  // style route.
  for (const id of ["w1:p1", "w11:p1", "wT:pG"]) {
    expect(agentIdFromHash(agentHash(id))).toBe(id);
  }
  expect(agentHash("w1:p1")).toBe("#/agent/w1%3Ap1");
});

test("the list address and unrelated hashes address no agent", () => {
  for (const hash of ["", "#", "#/", "#/agents", "#/agent", "#settings"]) {
    expect(agentIdFromHash(hash)).toBeNull();
  }
});

test("a malformed hash lands on the list instead of throwing", () => {
  // A truncated or hand-edited URL reaches this function as a lone `%`, which
  // makes decodeURIComponent throw. Rendering the list is a recoverable
  // outcome; an exception here would take down the whole app on a bad link.
  expect(agentIdFromHash("#/agent/%")).toBeNull();
  expect(agentIdFromHash("#/agent/%E0%A4%A")).toBeNull();
});

test("an empty id addresses no agent", () => {
  // Returning "" would send the caller looking up an agent whose id is the
  // empty string, which no store can answer.
  expect(agentIdFromHash("#/agent/")).toBeNull();
});
