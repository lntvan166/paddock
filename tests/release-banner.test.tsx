// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { beforeEach, expect, test } from "bun:test";
import { ReleaseBanner } from "@web/components/ReleaseBanner";
import { dismissedRelease, dismissRelease } from "@web/release-notice";
import { render } from "./support/render";

beforeEach(() => {
  try { localStorage.clear(); } catch { /* fails open, same as the module */ }
});

test("the banner names the version and the command, and says where to run it", async () => {
  const host = await render(<ReleaseBanner version="9.9.9" managedBy={null} onDismiss={() => {}} />);
  const text = host.textContent ?? "";
  expect(text).toContain("9.9.9");
  expect(text).toContain("paddock update");
  // The asymmetry that makes this notice different from every other one: you
  // cannot act on it from the device you are reading it on.
  expect(text).toContain("on the machine running it");
});

// Not a hover-revealed affordance, and not a bare div with a click handler:
// on a phone there is no hover, and the control must be announced as a control.
test("the dismiss control is a real, labelled button", async () => {
  const host = await render(<ReleaseBanner version="9.9.9" managedBy={null} onDismiss={() => {}} />);
  const btn = host.querySelector("button");
  expect(btn).not.toBeNull();
  expect(btn!.getAttribute("aria-label")).toBe("Dismiss update notice");
});

test("dismissing calls back", async () => {
  const calls: string[] = [];
  const host = await render(
    <ReleaseBanner version="9.9.9" managedBy={null} onDismiss={() => { calls.push("dismissed"); }} />,
  );
  host.querySelector("button")!.click();
  expect(calls).toEqual(["dismissed"]);
});

test("a dismissal is remembered per version, so a newer release comes back", () => {
  dismissRelease("0.8.0");
  expect(dismissedRelease()).toBe("0.8.0");
  // The point of storing the version rather than a boolean.
  expect(dismissedRelease()).not.toBe("0.9.0");
});

// Announced as a status region, so a screen reader is told without the focus
// being stolen from whatever the operator was reading.
test("the banner is a status region", async () => {
  const host = await render(<ReleaseBanner version="9.9.9" managedBy={null} onDismiss={() => {}} />);
  expect(host.querySelector('[role="status"]')).not.toBeNull();
});

// --- Homebrew installs -------------------------------------------------
//
// `paddock update` refuses inside a Homebrew keg (src/server/update.ts), so a
// banner that names it is telling the operator to run a command that declines.
// CLAUDE.md's rule about never guessing a keystroke for a blocked agent is the
// same principle: a control labelled with the wrong action is worse than none.

test("under Homebrew the banner names brew upgrade, not the command that declines", async () => {
  const host = await render(
    <ReleaseBanner version="9.9.9" managedBy="homebrew" onDismiss={() => {}} />,
  );
  const text = host.textContent ?? "";
  expect(text).toContain("9.9.9");
  expect(text).toContain("brew upgrade paddock");
  expect(text).not.toContain("paddock update");
});

test("under Homebrew it still says where to run it", async () => {
  // The asymmetry is unchanged by the package manager: `brew upgrade` runs on
  // the machine serving the dashboard, not on the phone reading it.
  const host = await render(
    <ReleaseBanner version="9.9.9" managedBy="homebrew" onDismiss={() => {}} />,
  );
  expect(host.textContent ?? "").toContain("on the machine running it");
});

test("with no package manager the banner is unchanged", async () => {
  // managedBy is absent for every install that is not a keg -- the installer's
  // ~/.local/bin, a container, a source build. Those must keep the command
  // that works for them.
  const host = await render(
    <ReleaseBanner version="9.9.9" managedBy={null} onDismiss={() => {}} />,
  );
  const text = host.textContent ?? "";
  expect(text).toContain("paddock update");
  expect(text).not.toContain("brew");
});
