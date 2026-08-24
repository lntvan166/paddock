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
    notifyEnabled: true, setNotifyEnabled: () => {},
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

test("the master switch sits in the card header, not in the body", async () => {
  // A master switch governs the whole card, so it belongs beside the title
  // rather than being the first of several equal rows. This is `Card`'s
  // `control` slot and the only consumer of it.
  const host = await render(<NotifySection {...props()} />);
  const head = host.querySelector(".card-head") as HTMLElement;
  expect(head.querySelector("[role='switch'][aria-label='Notifications']")).not.toBeNull();
  expect(host.querySelector(".card-body [role='switch'][aria-label='Notifications']")).toBeNull();
});
