// FIRST: React reads `document` at import time — see tests/terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import type { AskDialog } from "@shared/types";
import { AskDialogView } from "@web/components/AskDialogView";
import { click, render, textsOf, typeInto, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const multi: AskDialog = {
  questions: [
    { label: "Tea", answered: false, current: true, isSubmit: false },
    { label: "Coffee", answered: true, current: false, isSubmit: false },
    { label: "Submit", answered: false, current: false, isSubmit: true },
  ],
  question: "Which teas do you drink?",
  mode: "multi",
  options: [
    { key: "1", label: "Green tea", checked: true, freeText: false, detail: "Light and grassy." },
    { key: "2", label: "Black tea", checked: false, freeText: false, detail: "Strong and malty." },
    { key: "3", label: "Type something", checked: false, freeText: true },
  ],
  advance: "Next",
  cursor: { kind: "option", key: "1" },
};

const single: AskDialog = {
  ...multi,
  mode: "single",
  advance: null,
  options: [
    { key: "1", label: "Mango", picked: false, freeText: false, detail: "Tropical." },
    { key: "2", label: "Apple", picked: true, freeText: false, detail: "Crisp." },
    { key: "3", label: "Type something.", picked: false, freeText: true },
  ],
};

const noop = () => {};
type Props = Parameters<typeof AskDialogView>[0];
const view = (over: Partial<Props> = {}) => (
  <AskDialogView
    dialog={multi} busy={false} onToggle={noop} onArrow={noop} onType={noop}
    {...over}
  />
);

test("each option carries the agent's own label and its real state", async () => {
  const host = await render(view());

  // The free-text row is NOT among the buttons — see the test below for why.
  expect(textsOf(host, ".dialog-option .dialog-option-label")).toEqual([
    "Green tea", "Black tea",
  ]);
  const pressed = [...host.querySelectorAll(".dialog-option")]
    .map((b) => b.getAttribute("aria-pressed"));
  expect(pressed, "state is read off the screen, not tracked locally").toEqual(["true", "false"]);
});

test("tapping an option sends that option's own digit", async () => {
  const sent: string[] = [];
  const host = await render(view({ onToggle: (k: string) => sent.push(k) }));

  await click(host.querySelector('[data-dialog-option="2"]'));

  // Measured: in multi-select a digit toggles exactly that option and submits
  // nothing. The digit is the agent's own, never derived.
  expect(sent).toEqual(["2"]);
});

test("a single pick reads as a pick, not as a checkbox", async () => {
  const host = await render(view({ dialog: single }));

  const pressed = [...host.querySelectorAll(".dialog-option")]
    .map((b) => b.getAttribute("aria-pressed"));
  expect(pressed).toEqual(["false", "true"]);
  // Measured: a digit here PICKS and advances immediately, so the button says
  // so rather than looking like a toggle the operator can flip back.
  expect(host.querySelector(".dialog-options")?.getAttribute("data-mode")).toBe("single");
});

test("the free-text row is never a tappable option, in either mode", async () => {
  // In single-select, a digit sent to that row picks it with empty text, which
  // DECLINES THE WHOLE DIALOG — measured, the transcript records "User declined
  // to answer questions". In multi-select the digit merely ticks a row with no
  // text in it, which answers nothing. Neither is worth a button.
  for (const dialog of [multi, single]) {
    const host = await render(view({ dialog }));
    expect(host.querySelector('[data-dialog-option="3"]'), dialog.mode).toBeNull();
    expect(host.querySelector(".dialog-text"), `${dialog.mode}: a field, not a button`).not.toBeNull();
    await unmount();
  }
});

test("in multi-select the free-text row is a field, and sending types the text", async () => {
  const typed: string[] = [];
  const host = await render(view({ onType: (t: string) => typed.push(t) }));

  await typeInto(host.querySelector(".dialog-text") as HTMLInputElement, "oolong");
  await click(host.querySelector(".dialog-text-send"));

  expect(typed).toEqual(["oolong"]);
});

test("the field shows what is already in the row rather than looking empty", async () => {
  // After a send the row's LABEL is the text — that is how the screen carries
  // it — so an empty-looking field over text the agent is holding would be a
  // control disagreeing with the screen behind it.
  const host = await render(view({
    dialog: {
      ...multi,
      options: [
        ...multi.options.slice(0, 2),
        { key: "3", label: "oolong", checked: true, freeText: true },
      ],
    },
  }));

  const field = host.querySelector(".dialog-text") as HTMLInputElement;
  expect(field.placeholder).toBe("oolong");
});

test("single-select gets the field too, and is told Enter sends it", async () => {
  // An earlier version withheld it here, on a measurement that was wrong. What
  // is still true is narrower: typing fills the row but does not commit, and
  // Enter on an EMPTY row declines the whole dialog — so the note explains the
  // one step the operator still has to take.
  const host = await render(view({ dialog: single }));

  expect(host.querySelector(".dialog-text")).not.toBeNull();
  expect(host.textContent).toContain("press Enter");
});

test("the question strip shows where you are and moves one step at a time", async () => {
  const arrows: string[] = [];
  const host = await render(view({ onArrow: (k: "left" | "right") => arrows.push(k) }));

  expect(textsOf(host, ".dialog-tab")).toEqual(["Tea", "Coffee ☒", "Submit"]);
  expect(host.querySelector('.dialog-tab[aria-current="step"]')?.textContent).toContain("Tea");

  await click(host.querySelector(".dialog-next-q"));
  expect(arrows).toEqual(["right"]);
  await click(host.querySelector(".dialog-prev-q"));
  expect(arrows).toEqual(["right", "left"]);
});

test("with one question there is no strip to render", async () => {
  const host = await render(view({
    dialog: {
      ...multi,
      questions: [
        { label: "Tea", answered: false, current: true, isSubmit: false },
        { label: "Submit", answered: false, current: false, isSubmit: true },
      ],
    },
  }));

  expect(host.querySelector(".dialog-tabs")).toBeNull();
});

test("there is no Next button — the arrows reach every tab, Submit included", async () => {
  // Two controls doing one job was one more surface for the bug that one
  // actually shipped with: Enter acts on the cursor's row, so it unticked an
  // option instead of advancing.
  const host = await render(view());

  expect(host.querySelector(".dialog-advance")).toBeNull();
  expect(host.querySelector(".dialog-next-q"), "the arrow does that job").not.toBeNull();
});

test("an option shows its label, and NOT the agent's description of it", async () => {
  // The descriptions duplicated the agent's own screen three inches above, and
  // measured, they were most of the panel's height: with them the transcript
  // got 239px of an 844px phone. The label stays, because a bare digit only
  // says what it does while the screen behind it stays still — and it scrolls.
  const host = await render(view());

  expect(textsOf(host, ".dialog-option-label")).toEqual(["Green tea", "Black tea"]);
  expect(host.querySelector(".dialog-option-detail")).toBeNull();
  expect(host.textContent).not.toContain("Light and grassy");
});

test("every control goes dead while one is in flight", async () => {
  const host = await render(view({ busy: true }));

  for (const b of host.querySelectorAll("button")) {
    expect((b as HTMLButtonElement).disabled, b.className).toBe(true);
  }
});
