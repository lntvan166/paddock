import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { CardPrompt } from "@web/components/CardPrompt";
import { agent, click, render, settle, stubFetch, unmount } from "./support/render";

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
});

/**
 * A blocked agent answered from its dashboard card.
 *
 * The rules are the terminal's, restated where a one-tap answer is easiest to
 * get wrong: buttons only for a parsed permission prompt answered by its
 * digit, the agent's own labels and digits, and never a one-tap answer for a
 * question dialog, which is deliberative and must be answered in the terminal.
 */
const PERMISSION = {
  question: "Do you want to proceed?",
  options: [
    { key: "1", label: "Yes", selected: true },
    { key: "2", label: "Yes, and don't ask again for: bun run migrate *", selected: false },
    { key: "3", label: "No", selected: false },
  ],
  selected: "1. Yes",
  notes: null,
  commit: "digit",
  dialog: null,
  raw: "",
};

async function mount(prompt: unknown, answer: () => unknown = () => ({ ok: true })) {
  const stub = stubFetch({ "/prompt": () => prompt, "/answer": answer });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<CardPrompt agent={agent({ state: "blocked" })} onOpen={() => {}} />);
  await settle();
  return { host, calls: stub.calls };
}

test("a parsed permission prompt gets one button per option, with the agent's own labels and digits", async () => {
  const { host } = await mount(PERMISSION);
  const opts = [...host.querySelectorAll("[data-prompt-option]")];
  expect(opts.map((o) => o.getAttribute("data-prompt-option"))).toEqual(["1", "2", "3"]);
  expect(host.querySelector(".card-option-label")?.textContent).toBe("Yes");
  expect(host.querySelector(".card-question")?.textContent).toBe("Do you want to proceed?");
});

test("tapping an option sends THAT option's digit to /answer", async () => {
  const { host, calls } = await mount(PERMISSION);
  await click(host.querySelector('[data-prompt-option="3"]') as HTMLElement);
  await settle();
  const sent = calls.find((c) => c.url.includes("/answer"));
  expect(sent?.body).toEqual({ key: "3" });
});

test("the persistent grant is tagged, and the cursor is information, not a recommendation", async () => {
  const { host } = await mount(PERMISSION);
  const second = host.querySelector('[data-prompt-option="2"]') as HTMLElement;
  expect(second.querySelector(".card-option-note")?.textContent).toBe("remembered");
  const first = host.querySelector('[data-prompt-option="1"]') as HTMLElement;
  // Drawn, not the U+276F dingbat, which paints as emoji on some platforms.
  expect(first.querySelector(".card-option-cursor svg")).not.toBeNull();
  expect(second.querySelector(".card-option-cursor svg")).toBeNull();
});

test("a question dialog is never answered from the card", async () => {
  const { host } = await mount({ ...PERMISSION, commit: "cursor" });
  expect(host.querySelectorAll("[data-prompt-option]").length).toBe(0);
  // The way into the terminal is still there.
  expect(host.textContent).toContain("Open terminal");
});

test("a recognised dialog is never answered from the card either", async () => {
  const { host } = await mount({ ...PERMISSION, dialog: { kind: "ask" } });
  expect(host.querySelectorAll("[data-prompt-option]").length).toBe(0);
});

test("an unparsed prompt offers no buttons at all", async () => {
  const { host } = await mount({ ...PERMISSION, options: null });
  expect(host.querySelectorAll("[data-prompt-option]").length).toBe(0);
  expect(host.textContent).toContain("Open terminal");
});

test("a refused answer is said on the card", async () => {
  const { host } = await mount(PERMISSION, () => ({ ok: false, detail: "Someone answered at the desk first." }));
  await click(host.querySelector('[data-prompt-option="1"]') as HTMLElement);
  await settle();
  expect(host.querySelector(".card-prompt-error")?.textContent).toBe("Someone answered at the desk first.");
});

test("a NEW question on the same agent is re-read, not answered with the last one's buttons", async () => {
  // The used-screen case: the operator answered once, the agent asked again.
  // Same agentId, new stateSince — the card must fetch the new prompt.
  let n = 0;
  const stub = stubFetch({
    "/prompt": () => (++n === 1 ? PERMISSION : { ...PERMISSION, question: "Overwrite schema.sql?" }),
  });
  globalThis.fetch = stub.fn as unknown as typeof fetch;
  const host = await render(<CardPrompt agent={agent({ state: "blocked", stateSince: 1 })} />);
  await settle();
  expect(host.querySelector(".card-question")?.textContent).toBe("Do you want to proceed?");
  await render(<CardPrompt agent={agent({ state: "blocked", stateSince: 2 })} />, host);
  await settle();
  expect(host.querySelector(".card-question")?.textContent).toBe("Overwrite schema.sql?");
});
