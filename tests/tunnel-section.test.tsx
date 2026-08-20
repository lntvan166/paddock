// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported (tests/support/dom.ts).
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import type { NotifyTrigger } from "@shared/types";
import { isQuickTunnelUrl } from "@shared/quick-tunnel";
import { TunnelSection } from "@web/components/settings/TunnelSection";
import { NotifySection } from "@web/components/settings/NotifySection";
import { render, settle, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

function buttonByText(host: HTMLElement, text: RegExp): HTMLButtonElement {
  const btn = [...host.querySelectorAll("button")].find((b) => text.test(b.textContent ?? ""));
  if (!btn) throw new Error(`no button matching ${text}`);
  return btn as HTMLButtonElement;
}

const tunnel = { url: "https://quiet-harbor-8f31.trycloudflare.com", pairedDevices: 2 };
const ok = async () => ({ code: "9T2H-BXQ4", expiresAt: 0 });

test("the paired count is shown", async () => {
  const host = await render(<TunnelSection tunnel={tunnel} onInvite={ok} />);
  expect(host.textContent).toContain("2");
});

test("the code is never rendered before it is asked for", async () => {
  const host = await render(<TunnelSection tunnel={tunnel} onInvite={ok} />);
  expect(host.textContent).not.toContain("9T2H-BXQ4");
});

test("add a device reveals a code from the server", async () => {
  const host = await render(<TunnelSection tunnel={tunnel} onInvite={ok} />);
  buttonByText(host, /add a device/i).click();
  await settle();
  await settle();
  expect(host.textContent).toContain("9T2H-BXQ4");
});

test("a failed invite says so rather than showing a stale code", async () => {
  const host = await render(
    <TunnelSection tunnel={tunnel} onInvite={async () => { throw new Error("nope"); }} />,
  );
  buttonByText(host, /add a device/i).click();
  await settle();
  await settle();
  const alert = host.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert!.textContent).toMatch(/could not/i);
  // And no code is left behind from any earlier successful mint.
  expect(host.textContent).not.toContain("9T2H-BXQ4");
});

test("a second failed invite clears a code shown by an earlier successful one", async () => {
  // "clear any previously shown code" only means something if a code was on
  // screen to begin with — this exercises the transition, not just the
  // always-failed case above.
  let fail = false;
  const flaky = async () => {
    if (fail) throw new Error("gone");
    return { code: "9T2H-BXQ4", expiresAt: 0 };
  };
  const host = await render(<TunnelSection tunnel={tunnel} onInvite={flaky} />);
  buttonByText(host, /add a device/i).click();
  await settle();
  await settle();
  expect(host.textContent).toContain("9T2H-BXQ4");

  fail = true;
  buttonByText(host, /add a device/i).click();
  await settle();
  await settle();
  expect(host.textContent).not.toContain("9T2H-BXQ4");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

// Guards against the warning in NotifySection growing its own copy of the
// hostname rule instead of asking the one predicate that both the server
// preflight and the UI hint are built from.
test("the predicate is what the UI asks, not a second regex", () => {
  expect(isQuickTunnelUrl("https://quiet-harbor-8f31.trycloudflare.com")).toBe(true);
  expect(isQuickTunnelUrl("https://paddock.example.com")).toBe(false);
});

/**
 * `NotifySection` is rendered directly, the way `tests/prefs-applied.test.tsx`
 * renders `AgentTerminal` on its own rather than mounting the whole page: no
 * fetch stub is needed because this component takes every field as a prop and
 * makes no request of its own. Every prop is required, so a full, minimal set
 * is supplied rather than a partial cast — the same reasoning
 * `tests/prefs-applied.test.tsx` gives for building a real `SettingsView`
 * fixture instead of stubbing an answer of `undefined`.
 */
function notifySectionProps(publicUrl: string) {
  return {
    notifyEnabled: false,
    setNotifyEnabled: () => {},
    triggers: [] as NotifyTrigger[],
    toggleTrigger: () => {},
    cooldownMs: 60_000,
    setCooldownMs: () => {},
    publicUrl,
    setPublicUrl: () => {},
    settleMs: { blocked: 5_000, done: 10_000 },
    setSettleMs: () => {},
    mutedUntil: null,
    serverNow: 0,
    onMute: () => {},
    muting: false,
  };
}

test("a saved quick-tunnel publicUrl is flagged as stale", async () => {
  const host = await render(
    <NotifySection {...notifySectionProps("https://quiet-harbor-8f31.trycloudflare.com")} />,
  );
  expect(host.textContent).toMatch(/changes every time/i);
});

test("a real hostname is not flagged", async () => {
  const host = await render(<NotifySection {...notifySectionProps("https://paddock.example.com")} />);
  expect(host.textContent).not.toMatch(/changes every time/i);
});

test("an empty publicUrl is not flagged", async () => {
  // Empty is the recommended state while using `paddock tunnel` — the
  // warning must not fire on the very value it tells the operator to leave
  // the field at.
  const host = await render(<NotifySection {...notifySectionProps("")} />);
  expect(host.textContent).not.toMatch(/changes every time/i);
});
