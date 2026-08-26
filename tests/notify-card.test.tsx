import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { NotifySection, type NotifySectionProps } from "@web/components/settings/NotifySection";
import { render, textsOf, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

/**
 * Every prop NotifySectionProps requires.
 *
 * The RETURN TYPE is annotated rather than the call sites being cast: that is
 * what makes `triggers: ["blocked"]` infer as NotifyTrigger[] instead of a
 * readonly tuple, and it means a fixture that drifts from the component's real
 * prop shape is a compile error here rather than something a cast hides.
 */
function props(over: Partial<NotifySectionProps> = {}): NotifySectionProps {
  return {
    telegramOn: true, setTelegramOn: () => {}, pushOn: false, setPushOn: () => {}, pushDevices: 0,
    skipWhileViewing: false, setSkipWhileViewing: () => {},
    triggers: ["blocked"], toggleTrigger: () => {},
    cooldownMs: 60_000, setCooldownMs: () => {},
    publicUrl: "", setPublicUrl: () => {},
    settleMs: { blocked: 5_000, done: 10_000 }, setSettleMs: () => {},
    mutedUntil: null, serverNow: 1_700_000_000_000,
    onMute: () => {}, muting: false,
    ...over,
  };
}

test("the notifications group is a titled card", async () => {
  // It had no heading of its own before: the only <h2> was "All devices", on
  // the section wrapping both this and Telegram.
  const host = await render(<NotifySection {...props()} />);
  expect(textsOf(host, ".card-title")).toEqual(["Notifications"]);
});

test("the quick-tunnel warning is stated in the card footer, not floated inline", async () => {
  // An explanation of why a field should be LEFT ALONE belongs to the setting.
  // A quick-tunnel hostname changes every run, so saving it points notification
  // links at a name that has stopped resolving.
  const host = await render(
    <NotifySection {...props({ publicUrl: "https://random-words-here.trycloudflare.com" })} />,
  );
  const foot = host.querySelector(".card-foot") as HTMLElement;
  expect(foot).not.toBeNull();
  expect(foot.textContent).toContain("quick-tunnel URL");
});

test("an ordinary public URL leaves the footer off entirely", async () => {
  // An empty divided region reads as a rendering bug.
  const host = await render(
    <NotifySection {...props({ publicUrl: "https://paddock.example.com" })} />,
  );
  expect(host.querySelector(".card-foot")).toBeNull();
});

test("the two transports are checkboxes in the body, and there is no master switch", async () => {
  // This asserted a master switch in the card's `control` slot. It is gone on
  // purpose: two transport checkboxes ARE the master, because both off is
  // already "send nothing", and a third flag above them would only be a way
  // for the three to disagree.
  //
  // They sit in the BODY rather than the header because the header slot holds
  // one control that governs the card, and these are two peers — and because
  // the rules underneath (triggers, mute, cooldown) apply to both of them, so
  // the checkboxes belong at the top of what they govern.
  const host = await render(<NotifySection {...props()} />);

  const head = host.querySelector(".card-head") as HTMLElement;
  expect(head.querySelector("[role='switch']")).toBeNull();

  const transports = host.querySelector(".notify-transports") as HTMLElement;
  expect(transports).not.toBeNull();
  expect(transports.textContent).toContain("Telegram");
  expect(transports.textContent).toContain("Web push");
  // Two, and exactly two — a third would mean a transport nothing delivers.
  expect(transports.querySelectorAll("[role='checkbox'], input[type='checkbox']").length).toBe(2);
});

test("the push row says when no device is registered, rather than looking ready", async () => {
  // A checked box with nowhere to deliver is the failure this area has already
  // produced twice — once because a server flag was never set, once because an
  // unconfigured Telegram returned before push was reached. Both were silent.
  const host = await render(<NotifySection {...props()} pushOn={true} pushDevices={0} />);
  expect(host.querySelector(".notify-transports")?.textContent)
    .toContain("No device registered yet");
});

test("the push row counts the devices when there are some", async () => {
  const one = await render(<NotifySection {...props()} pushOn={true} pushDevices={1} />);
  expect(one.querySelector(".notify-transports")?.textContent).toContain("1 device registered");
  await unmount();
  const many = await render(<NotifySection {...props()} pushOn={true} pushDevices={3} />);
  expect(many.querySelector(".notify-transports")?.textContent).toContain("3 devices registered");
});

test("the watching setting states what it does to push, and to Telegram", async () => {
  // A feature that withholds a buzz reads as a broken feature unless the UI
  // says otherwise — and it must not appear to govern Telegram, which presence
  // cannot speak for.
  const host = await render(<NotifySection {...props()} />);
  const text = host.textContent ?? "";
  expect(text).toContain("Skip push for the agent I'm watching");
  expect(text).toContain("waits until you leave");
  expect(text).toContain("Telegram");
});

test("the watching checkbox reports its state", async () => {
  const host = await render(<NotifySection {...props({ skipWhileViewing: true })} />);
  const box = host.querySelector('[aria-label="Skip push for the agent I\'m watching"]');
  expect(box?.getAttribute("data-state")).toBe("checked");
});
