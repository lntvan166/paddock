import { expect, test } from "bun:test";
import { demoActions, demoTree } from "@server/demo-actions";

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

test("every write on the interface is covered by the list above", () => {
  // Guards the guard. A method added to `HerdrActions` and implemented in the
  // shim, but not listed here, would go untested — and the defect this file
  // exists to catch is exactly one write quietly resolving.
  const READS = new Set(["readOutput", "readPane", "readPromptScreen", "harnessKinds"]);
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
