import { expect, test } from "bun:test";
import { answerQuestion, questionOnlyIo, QuestionOnlyError } from "@server/mcp/answer";
import { AgentStore } from "@server/state/store";
import type { Agent } from "@shared/types";

/**
 * A question dialog the fake can drive: ↑/↓ move the cursor, typing on the
 * free-text row replaces its label, Enter commits the row under the cursor.
 * Invented content throughout.
 */
function fakeDialog(o: { cursor?: number; multi?: boolean; labels?: string[]; afterReads?: { n: number; screen: string } } = {}) {
  let cursor = o.cursor ?? 1;
  let typed: string | null = null;
  let committed: string | null = null;
  let reads = 0;
  const keys: string[] = [];
  const labels = o.labels ?? ["Mango", "Apple"];
  const free = labels.length + 1;

  const row = (n: number, label: string) => {
    const mark = n === cursor ? "❯" : " ";
    return o.multi ? `${mark} ${n}. [ ] ${label}` : `${mark} ${n}. ${label}`;
  };
  const screen = (): string => [
    "←  ☐ Fruit  ✔ Submit  →",
    "",
    "Which is your favourite fruit?",
    "",
    ...labels.flatMap((l, i) => [row(i + 1, l), "     A fruit."]),
    row(free, typed ?? "Type something."),
    ...(o.multi ? ["     Next"] : []),
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");

  return {
    keys,
    committed: () => committed,
    io: {
      async readPromptScreen() {
        reads++;
        if (o.afterReads && reads > o.afterReads.n) return o.afterReads.screen;
        return screen();
      },
      async sendNavKey(_t: string, k: string) {
        keys.push(k);
        if (k === "down") cursor = Math.min(free, cursor + 1);
        else if (k === "up") cursor = Math.max(1, cursor - 1);
        else if (k === "enter") committed = cursor === free ? `text:${typed}` : labels[cursor - 1]!;
      },
      async sendChars(_t: string, chars: string[]) {
        keys.push(`chars:${chars.join("")}`);
        if (cursor === free) typed = (typed ?? "") + chars.join("");
      },
      async sendOptionKey(_t: string, k: string) {
        keys.push(`digit:${k}`);
        // Single-select: a digit picks that option. On the text row it would be text.
        if (cursor === free) typed = (typed ?? "") + k;
        else committed = labels[Number(k) - 1] ?? null;
      },
      settle: async () => {},
    },
  };
}

const PERMISSION = "Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n\nEnter to select · ↑/↓ to navigate\n";

function store(state: Agent["state"] = "blocked") {
  const s = new AgentStore("dev-box");
  s.replaceAll([{
    hostId: "dev-box", agentId: "w1:p1", name: "docs-cleanup", task: "Rewrite the quickstart", state,
    workspaceId: "w1", workspaceLabel: null, cwd: "/path/to/project", harness: "claude",
    stateSince: 0, stateSinceExact: true, updatedAt: 0, acknowledgedAt: null, hasJournal: true, origin: "herdr", turn: null, seen: null,
  }], 0, "herdr");
  return s;
}

const answer = (d: ReturnType<typeof fakeDialog>, input: { option?: string; text?: string }, s = store()) =>
  answerQuestion(s, "w1:p1", input, d.io as never) as Promise<any>;

test("a permission prompt is refused, and no key is sent", async () => {
  const d = fakeDialog();
  d.io.readPromptScreen = async () => PERMISSION;
  const r = await answer(d, { option: "Yes" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("only the operator");
  expect(d.keys).toEqual([]);
});

test("a label match picks the option by its own digit", async () => {
  const d = fakeDialog();
  const r = await answer(d, { option: "Apple" });
  expect(r.ok).toBe(true);
  expect(d.keys).toEqual(["digit:2"]);
  expect(d.committed()).toBe("Apple");
});

test("from a USED dialog: the cursor parked on the text row is moved off first", async () => {
  // On the text row a digit is typed, not picked — the bug /dialog-key fixed.
  const d = fakeDialog({ cursor: 3 });
  expect((await answer(d, { option: "Mango" })).ok).toBe(true);
  expect(d.committed()).toBe("Mango");
  expect(d.keys.indexOf("up")).toBeLessThan(d.keys.indexOf("digit:1"));
});

test("labels are matched after trimming, never by position", async () => {
  const d = fakeDialog();
  expect((await answer(d, { option: "  Apple " })).ok).toBe(true);
  expect(d.committed()).toBe("Apple");
  const e = fakeDialog();
  const r = await answer(e, { option: "2" });
  expect(r.ok).toBe(false);
  expect(e.keys).toEqual([]);
});

test("an unknown label lists the real labels", async () => {
  const d = fakeDialog();
  const r = await answer(d, { option: "Pear" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("Mango");
  expect(r.error).toContain("Apple");
  expect(d.keys).toEqual([]);
});

test("a duplicate label is refused", async () => {
  const d = fakeDialog({ labels: ["Mango", "Mango"] });
  const r = await answer(d, { option: "Mango" });
  expect(r.ok).toBe(false);
  expect(d.keys).toEqual([]);
});

test("the free-text row cannot be picked by its label", async () => {
  const d = fakeDialog();
  const r = await answer(d, { option: "Type something." });
  expect(r.ok).toBe(false);
  expect(d.keys).toEqual([]);
});

test("multi-select is refused in v1", async () => {
  const d = fakeDialog({ multi: true });
  const r = await answer(d, { option: "Mango" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("multi-select");
  expect(d.keys).toEqual([]);
});

test("exactly one of option and text", async () => {
  expect((await answer(fakeDialog(), {})).ok).toBe(false);
  expect((await answer(fakeDialog(), { option: "Mango", text: "kiwi" })).ok).toBe(false);
});

test("text without a free-text row is refused", async () => {
  const d = fakeDialog();
  const noFree = (await d.io.readPromptScreen()).replace(/^.*Type something\.$/m, "");
  d.io.readPromptScreen = async () => noFree;
  const r = await answer(d, { text: "kiwi" });
  expect(r.ok).toBe(false);
  expect(d.keys).toEqual([]);
});

test("text types into the free-text row, then commits it", async () => {
  const d = fakeDialog();
  const r = await answer(d, { text: "kiwi" });
  expect(r.ok).toBe(true);
  expect(d.committed()).toBe("text:kiwi");
});

test("text with a control character is refused", async () => {
  const d = fakeDialog();
  expect((await answer(d, { text: "kiwi\n" })).ok).toBe(false);
  expect(d.keys).toEqual([]);
});

test("a permission screen on a later read stops the call before enter", async () => {
  // Read 1 is the classification, read 2 is the helper's own look, which now
  // finds a permission prompt. Nothing may be sent after it.
  const d = fakeDialog({ afterReads: { n: 1, screen: PERMISSION } });
  const r = await answer(d, { option: "Apple" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("stopped being a question dialog");
  expect(d.keys).toEqual([]);
});

test("a permission screen after typing stops the free-text commit", async () => {
  // Classification, typeIntoFreeText's look, then the pre-Enter check sees a prompt.
  const d = fakeDialog({ cursor: 3, afterReads: { n: 2, screen: PERMISSION } });
  const r = await answer(d, { text: "kiwi" });
  expect(r.ok).toBe(false);
  expect(d.keys).not.toContain("enter");
});

test("an agent that is not blocked is refused", async () => {
  const d = fakeDialog();
  const r = await answer(d, { option: "Mango" }, store("working"));
  expect(r.ok).toBe(false);
  expect(d.keys).toEqual([]);
});

test("questionOnlyIo throws on a non-question screen", async () => {
  const io = questionOnlyIo({ ...fakeDialog().io, readPromptScreen: async () => PERMISSION } as never);
  await expect(io.readPromptScreen("w1:p1")).rejects.toBeInstanceOf(QuestionOnlyError);
});

test("answer_question is a registered tool and logs the label length, not the label", async () => {
  const { bridgeTools } = await import("@server/mcp/tools");
  const { AgentWatch } = await import("@server/mcp/watch");
  const d = fakeDialog();
  const lines: string[] = [];
  const tools = bridgeTools({
    store: store(), actions: {} as never, watch: new AgentWatch(), dialogIo: d.io as never, log: (l) => lines.push(l),
  });
  const r = await tools.find((t) => t.name === "answer_question")!.call({ id: "w1:p1", option: "Apple" });
  expect(r.ok).toBe(true);
  expect(lines).toEqual(["mcp: answer_question w1:p1 answered len=5"]);
});
