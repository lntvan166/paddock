import { expect, test } from "bun:test";
import { addNote } from "@server/herdr/dialog-type";

/**
 * Sending a note, against a model of the dialog MEASURED on a live agent.
 *
 * The sequences are not interchangeable, and the difference is the whole point
 * of this file. The probe was asked to quote what it received:
 *
 *   n, type, Enter        ->  "…?"=(no option selected) notes: hello
 *   n, type, Esc, Enter   ->  "…?"="Scaffold a new Next.js app…" notes: ok
 *
 * With the cursor sitting VISIBLY on option 1, the first sequence still threw
 * that option away. So an implementation that opened the field, typed, and
 * pressed Enter would discard the operator's choice while looking correct on
 * screen — which is why the fake below models submission the way the real
 * dialog does, and why the assertions are about what was submitted rather than
 * about which keys were sent.
 */
type Submitted = { option: string | null; note: string };

function fakeDialog(startOpen = false) {
  let open = startOpen;
  let note = "";
  let submitted: Submitted | null = null;
  const keys: string[] = [];

  const screen = (): string =>
    [
      "Which setup path should I use for this project?",
      "",
      "❯ 1. Scaffold a brand new         ┌──────────────────┐",
      "    Next.js application from      └──────────────────┘",
      "  2. Clone an existing repository",
      `                                  Notes: ${
        open && note === "" ? "Add notes on this design…"
        : note === "" ? "press n to add notes"
        : note
      }`,
      "",
      open
        ? "Enter to select · ↑/↓ to navigate · n to add notes · ctrl+g to edit in VS Code · Esc to cancel"
        : "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
    ].join("\n");

  return {
    keys,
    submittedValue: () => submitted,
    io: {
      readPromptScreen: async () => screen(),
      sendNavKey: async (_t: string, key: string) => {
        keys.push(key);
        // Measured: Esc closes the field and KEEPS the note; Enter submits, and
        // what it submits depends entirely on whether the field is still open.
        if (key === "esc") open = false;
        else if (key === "enter") submitted = { option: open ? null : "1", note };
      },
      sendChars: async (_t: string, chars: string[]) => {
        keys.push(...chars);
        if (open) note += chars.join("");
        else if (chars.join("") === "n") open = true;
      },
      sendOptionKey: async () => {},
      settle: async () => {},
    },
  };
}

test("a note sent alone reaches the agent with no option chosen", () => {
  const d = fakeDialog();
  return addNote("w1:p1", [..."hello"], "note-only", d.io as never).then((r) => {
    expect(r.ok).toBe(true);
    expect(d.submittedValue()).toEqual({ option: null, note: "hello" });
  });
});

test("a note sent with the option commits both", async () => {
  const d = fakeDialog();
  const r = await addNote("w1:p1", [..."ok"], "with-option", d.io as never);
  expect(r.ok).toBe(true);
  expect(d.submittedValue()).toEqual({ option: "1", note: "ok" });
});

test("sending with the option escapes the field before committing", async () => {
  // The ordering IS the feature. Enter before Esc discards the option.
  const d = await (async () => {
    const f = fakeDialog();
    await addNote("w1:p1", [..."ok"], "with-option", f.io as never);
    return f;
  })();
  expect(d.keys.indexOf("esc")).toBeGreaterThan(-1);
  expect(d.keys.indexOf("esc")).toBeLessThan(d.keys.indexOf("enter"));
});

test("a note sent alone never sends Esc", async () => {
  const d = fakeDialog();
  await addNote("w1:p1", [..."hello"], "note-only", d.io as never);
  expect(d.keys).not.toContain("esc");
});

test("an already-open field is not reopened, which would type an n", () => {
  // `n` only opens the field when it is closed. Sent while open it is a
  // character, and the note would begin with a stray "n".
  const d = fakeDialog(true);
  return addNote("w1:p1", [..."hi"], "note-only", d.io as never).then(() => {
    expect(d.submittedValue()).toEqual({ option: null, note: "hi" });
  });
});

test("a prompt with no notes field is refused, not typed into", async () => {
  const io = {
    readPromptScreen: async () => "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel",
    sendNavKey: async () => { throw new Error("must not send keys"); },
    sendChars: async () => { throw new Error("must not send keys"); },
    sendOptionKey: async () => {},
    settle: async () => {},
  };
  const r = await addNote("w1:p1", [..."hi"], "note-only", io as never);
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("no notes");
});
