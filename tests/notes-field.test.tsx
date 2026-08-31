import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { NotesField } from "@web/components/NotesField";
import { click, render, typeInto, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

/**
 * The notes control, and why it has TWO send buttons.
 *
 * Measured on a live agent: with the field open, Enter submits the note alone
 * and DISCARDS the option the cursor is visibly sitting on. Pressing Esc first
 * keeps the note and lets Enter commit both. Those are two different answers,
 * so they are two different buttons — one control that picked for the operator
 * would be the mislabelled button this project refuses to ship.
 */
test("both answers are offered, and each says what it sends", async () => {
  const host = await render(
    <NotesField optionKey="1" busy={false} onSend={() => {}} />,
  );
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
  expect(labels.some((l) => /note only/i.test(l))).toBe(true);
  expect(labels.some((l) => /option 1/.test(l))).toBe(true);
});

test("the send button names the option number, not its whole sentence", async () => {
  // The chosen row is a marked radio directly above this button, so the
  // sentence is already on screen. Repeating it made a two-line block the
  // loudest thing on the dialog.
  const host = await render(<NotesField optionKey="2" busy={false} onSend={() => {}} />);
  const send = [...host.querySelectorAll("button")]
    .find((b) => /option 2/.test(b.textContent ?? ""));
  expect(send).toBeDefined();
  expect(send!.textContent).toBe("Send option 2");
});

test("with no option chosen, only the note-only answer is offered", async () => {
  // There is no option to commit, so a button claiming to commit one would be
  // claiming something paddock cannot see.
  const host = await render(<NotesField optionKey={null} busy={false} onSend={() => {}} />);
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
  expect(labels.some((l) => /note only/i.test(l))).toBe(true);
  expect(labels.length).toBe(1);
});

test("a note-only answer is refused until something has been typed", async () => {
  // An empty note sent as "notes only" is an answer that says nothing.
  const host = await render(
    <NotesField optionKey="1" busy={false} onSend={() => {}} />,
  );
  const noteOnly = [...host.querySelectorAll("button")]
    .find((b) => /note only/i.test(b.textContent ?? "")) as HTMLButtonElement;
  expect(noteOnly.disabled).toBe(true);
});

test("the option can be committed with no note at all", async () => {
  // Tapping an option MOVES the cursor now — it no longer answers — so this is
  // the only way to commit one, and disabling it would strand the operator on
  // a dialog they cannot answer without inventing a note.
  const host = await render(
    <NotesField optionKey="1" busy={false} onSend={() => {}} />,
  );
  const withOption = [...host.querySelectorAll("button")]
    .find((b) => /option 1/.test(b.textContent ?? "")) as HTMLButtonElement;
  expect(withOption.disabled).toBe(false);
});

test("the send button says whether a note is going with it", async () => {
  const host = await render(
    <NotesField optionKey="1" busy={false} onSend={() => {}} />,
  );
  const withOption = [...host.querySelectorAll("button")]
    .find((b) => /option 1/.test(b.textContent ?? ""))!;
  expect(withOption.textContent).toBe("Send option 1");

  await typeInto(host.querySelector("textarea") as HTMLTextAreaElement, "rebase first");
  expect(withOption.textContent).toBe("Send option 1 with note");
});

test("each button sends its own mode", async () => {
  const sent: Array<{ text: string; mode: string }> = [];
  const host = await render(
    <NotesField
      optionKey="1"
      busy={false}
      onSend={(text, mode) => sent.push({ text, mode })}
    />,
  );
  // The repo's helper, not a raw assignment: React only notices the value its
  // own native setter wrote, so `field.value = …` fires onChange for nobody.
  await typeInto(host.querySelector("textarea") as HTMLTextAreaElement, "please rebase first");

  const buttons = [...host.querySelectorAll("button")] as HTMLButtonElement[];
  await click(buttons.find((b) => /note only/i.test(b.textContent ?? ""))!);
  await click(buttons.find((b) => /option 1/.test(b.textContent ?? ""))!);

  expect(sent).toEqual([
    { text: "please rebase first", mode: "note-only" },
    { text: "please rebase first", mode: "with-option" },
  ]);
});

test("a busy field cannot be sent twice", async () => {
  const host = await render(
    <NotesField optionKey="1" busy={true} onSend={() => {}} />,
  );
  for (const b of host.querySelectorAll("button")) {
    expect((b as HTMLButtonElement).disabled).toBe(true);
  }
});
