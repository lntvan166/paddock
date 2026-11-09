import { expect, test } from "bun:test";
import { demoActions, demoTree } from "@server/demo-actions";
import { DEMO_BLOCKED_APP_AGENT_ID } from "@server/demo";

/**
 * The demo shim's one hard rule: reads answer, writes REFUSE.
 *
 * `CLAUDE.md` asks for this shim and states the constraint in the same breath:
 *
 *   > not worth doing carelessly, because a demo whose keys appear to work and
 *   > do nothing is exactly the mislabelled control this file bans elsewhere.
 *
 * A write that resolves quietly is that control. The failure would be silent
 * and total — every key in the demo looking live and doing nothing — and no
 * other test in the suite would notice, because a resolved promise is what a
 * successful send looks like.
 */

/** Every method on `HerdrActions` that changes something. */
const WRITES: [string, (a: ReturnType<typeof demoActions>) => Promise<unknown>][] = [
  ["sendOptionKey", (a) => a.sendOptionKey("d1:p1", "1")],
  ["sendNavKey", (a) => a.sendNavKey("d1:p1", "up")],
  ["sendChars", (a) => a.sendChars("d1:p1", ["h", "i"])],
  ["sendReply", (a) => a.sendReply("d1:p1", "yes")],
  ["sendPaneText", (a) => a.sendPaneText("d7:p1", "ls")],
  ["sendPaneKey", (a) => a.sendPaneKey("d7:p1", "up")],
  ["waitUntilUnblocked", (a) => a.waitUntilUnblocked("d1:p1")],
  ["renameAgent", (a) => a.renameAgent("d1:p1", "x")],
  ["renameTab", (a) => a.renameTab("d1:t1", "x")],
  ["renameSpace", (a) => a.renameSpace("d1", "x")],
  ["closeTab", (a) => a.closeTab("d1:t1")],
  ["closeSpace", (a) => a.closeSpace("d1")],
  ["createSpace", (a) => a.createSpace({})],
  ["createTab", (a) => a.createTab("d1", {})],
  ["startAgent", (a) => a.startAgent("d1:p1", "claude", "api-refactor")],
  ["markSeen", (a) => a.markSeen("d1:p1", 1)],
];

for (const [name, call] of WRITES) {
  test(`${name} refuses, and says why`, async () => {
    const a = demoActions();
    let message: string | null = null;
    try {
      await call(a);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, `${name} resolved instead of refusing`).not.toBeNull();
    // The message reaches the operator: the route catches it and returns it as
    // a 502 detail, which the UI already renders. So it has to say what
    // happened in words, not be an opaque throw.
    expect(message).toContain("demo");
  });
}

/**
 * The same writes, aimed at the demo's APP agent and app space. The shim does
 * not route by origin, so these refuse for the same reason the list above
 * does — and this is what proves it: a composite that sent `hc.` ids
 * somewhere else, or a shim that special-cased them, would show up here as a
 * write that resolved.
 */
const CORE_WRITES: [string, (a: ReturnType<typeof demoActions>) => Promise<unknown>][] = [
  ["sendOptionKey", (a) => a.sendOptionKey(DEMO_BLOCKED_APP_AGENT_ID, "1")],
  ["sendNavKey", (a) => a.sendNavKey(DEMO_BLOCKED_APP_AGENT_ID, "down")],
  ["sendChars", (a) => a.sendChars(DEMO_BLOCKED_APP_AGENT_ID, ["n"])],
  ["sendReply", (a) => a.sendReply("hc.t2", "ship it")],
  ["sendPaneText", (a) => a.sendPaneText("hc.t2", "ls")],
  ["sendPaneKey", (a) => a.sendPaneKey("hc.t2", "enter")],
  ["waitUntilUnblocked", (a) => a.waitUntilUnblocked(DEMO_BLOCKED_APP_AGENT_ID)],
  ["renameAgent", (a) => a.renameAgent("hc.t2", "x")],
  ["renameTab", (a) => a.renameTab("hc.tab-build", "x")],
  ["renameSpace", (a) => a.renameSpace("hc.docs-site", "x")],
  ["closeTab", (a) => a.closeTab("hc.tab-notes")],
  ["closeSpace", (a) => a.closeSpace("hc.docs-site")],
  ["createSpace", (a) => a.createSpace({ origin: "core" })],
  ["createTab", (a) => a.createTab("hc.docs-site", {})],
  ["startAgent", (a) => a.startAgent("hc.t2", "claude", "api-refactor")],
  ["markSeen", (a) => a.markSeen("hc.t2", 5)],
];

test("every demo write to a core id is refused with the demo message", async () => {
  const sentence = "this is the demo — paddock has no herdr here, so nothing was sent";
  for (const [name, call] of CORE_WRITES) {
    let message: string | null = null;
    try { await call(demoActions()); } catch (err) { message = (err as Error).message; }
    expect(message, `${name} on a core id resolved instead of refusing`).toBe(sentence);
  }
  // Guarded like the list above: a write added to the interface and left off
  // this list would go untested for app ids.
  expect(CORE_WRITES.map(([n]) => n).sort()).toEqual(WRITES.map(([n]) => n).sort());
});

test("the blocked app agent's prompt is a permission prompt the real parser reads", async () => {
  const raw = await demoActions().readPromptScreen(DEMO_BLOCKED_APP_AGENT_ID);
  expect(raw).toContain("Do you want to proceed?");
  expect(raw).toContain("1. Yes");
  expect(await demoActions().promptAllowed(DEMO_BLOCKED_APP_AGENT_ID)).toBe(true);
  const out = await demoActions().readOutput(DEMO_BLOCKED_APP_AGENT_ID, "blocked");
  expect(out.lines.join("\n")).toContain("Do you want to proceed?");
});

test("the tree carries one app space, docs-site, with two tabs", () => {
  const app = demoTree(1000).spaces.filter((s) => s.origin === "core");
  expect(app.map((s) => [s.spaceId, s.label])).toEqual([["hc.docs-site", "docs-site"]]);
  const tabs = app[0]!.tabs;
  expect(tabs).toHaveLength(2);
  expect(app[0]!.tabCount).toBe(2);
  for (const t of tabs) expect(t.tabId.startsWith("hc.")).toBe(true);
  const panes = tabs.flatMap((t) => t.panes);
  expect(panes.map((p) => p.paneId).sort()).toEqual(["hc.t1", "hc.t2"]);
  expect(panes.find((p) => p.paneId === DEMO_BLOCKED_APP_AGENT_ID)?.state).toBe("blocked");
});

test("every write on the interface is covered by the list above", () => {
  // Guards the guard. A method added to `HerdrActions` and implemented in the
  // shim, but not listed here, would go untested — and the defect this file
  // exists to catch is exactly one write quietly resolving.
  // `promptAllowed` is a READ (may one-tap buttons be shown?), not a write:
  // it changes nothing, so it answers like the others instead of refusing.
  const READS = new Set(["readOutput", "readPane", "readPromptScreen", "harnessKinds", "promptAllowed"]);
  const implemented = Object.keys(demoActions()).filter((k) => !READS.has(k));
  expect(implemented.sort()).toEqual(WRITES.map(([n]) => n).sort());
});

test("reads answer, so the terminal renders instead of erroring", async () => {
  const a = demoActions();
  const out = await a.readOutput("d1:p1", "blocked");
  expect(out.lines.length).toBeGreaterThan(0);
  expect(out.lines.join("\n")).toContain("Do you want to proceed?");
  expect(out.source).toBe("visible");
});

test("the blocked agent's detection is the real parser's input, not a parsed answer", async () => {
  // The demo must exercise the live prompt parser. Handing the UI a
  // pre-parsed option list would let a screenshot show buttons the real code
  // might not produce from the same bytes.
  const raw = await demoActions().readPromptScreen("d1:p1");
  expect(raw).toContain("1. Yes");
  expect(raw).toContain("3. No");
});

test("the demo's prompt may show its options, so the blocked screenshot keeps its buttons", async () => {
  expect(await demoActions().promptAllowed("d1:p1")).toBe(true);
});

test("an agent that is not blocked has no prompt to detect", async () => {
  expect(await demoActions().readPromptScreen("d3:p1")).toBe("");
});

test("the tree carries a pane with no agent, so both kinds are shown", () => {
  const tree = demoTree(1000);
  const panes = tree.spaces.flatMap((s) => s.tabs).flatMap((t) => t.panes);
  expect(panes.some((p) => p.harness !== null)).toBe(true);
  const shell = panes.find((p) => p.harness === null);
  expect(shell, "no shell pane in the demo tree").toBeDefined();
  // A shell is labelled by its FOLDER, so a prompt-shaped title here would put
  // a hostname on a screenshot — the disclosure §16.6 removed.
  expect(shell!.title).toBeNull();
  expect(shell!.state).toBeNull();
});

test("readAt is the moment it was asked", () => {
  // The Spaces screen renders "as of 3s ago" from this. A frozen timestamp
  // would age visibly on screen while the tree never changed.
  expect(demoTree(4242).readAt).toBe(4242);
});

test("nothing in the demo tree resembles real data", () => {
  // This is the one mode README media comes from. Names are invented, and the
  // cwd is a placeholder rather than anyone's home.
  const json = JSON.stringify(demoTree(0));
  expect(json).not.toContain("/home/");
  expect(json).not.toContain("/Users/");
  expect(json).toContain("~/demo-project");
});
