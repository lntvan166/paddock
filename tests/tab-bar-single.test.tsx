import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { AppShell } from "@web/components/AppShell";
import { render, settle, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

/**
 * The tab bar is chrome, and chrome does not get rebuilt.
 *
 * paddock rendered THREE `<TabBar>` instances — one inside App's dashboard,
 * one inside Spaces, one inside Settings. Every route change therefore
 * destroyed the bar and built a new one, which is visible on a phone as the
 * bar blinking on each navigation. Probed in a browser by tagging the bar's
 * DOM node and navigating: with the bar inside the screen the tagged node did
 * not survive; hoisted out, it was the same node before and after.
 *
 * These tests pin the shape that makes that impossible.
 */

test("the shell renders exactly one tab bar", async () => {
  const host = await render(
    <AppShell tab="agents" needsYou={0} onSelect={() => {}}>
      <main className="screen"><div className="screen-body">list</div></main>
    </AppShell>,
  );
  expect(document.querySelectorAll(".tab-bar").length).toBe(1);
  expect(host.textContent).toContain("list");
});

test("the bar is a SIBLING of the screen, never inside it", async () => {
  // Inside the screen is what made it get rebuilt. This assertion is the
  // whole point of the file — if it ever passes while nested, the blink is
  // back and nothing else would catch it.
  await render(
    <AppShell tab="spaces" needsYou={0} onSelect={() => {}}>
      <main className="screen"><div className="screen-body">spaces</div></main>
    </AppShell>,
  );
  const bar = document.querySelector(".tab-bar")!;
  expect(bar.closest(".screen"), "the tab bar is nested inside a screen").toBeNull();
});

test("swapping the child does not replace the bar", async () => {
  // The direct analogue of the browser probe: tag the node, change the
  // content, and require the same node afterwards.
  const host = await render(
    <AppShell tab="agents" needsYou={0} onSelect={() => {}}>
      <main className="screen">first</main>
    </AppShell>,
  );
  const before = document.querySelector(".tab-bar")! as HTMLElement;
  before.dataset.probe = "tagged";

  await render(
    <AppShell tab="spaces" needsYou={0} onSelect={() => {}}>
      <main className="screen">second</main>
    </AppShell>,
    host,
  );
  await settle();

  expect(host.textContent).toContain("second");
  const after = document.querySelector(".tab-bar")! as HTMLElement;
  expect(after.dataset.probe, "the tab bar was destroyed and rebuilt").toBe("tagged");
});

test("the badge count reaches the bar through the shell", async () => {
  await render(
    <AppShell tab="agents" needsYou={3} onSelect={() => {}}>
      <main className="screen">list</main>
    </AppShell>,
  );
  expect(document.querySelector(".tab-badge")?.textContent).toBe("3");
});

test("tapping a tab reports the choice instead of navigating", async () => {
  // The anchor keeps a real href so the URL stays copyable, but the default
  // navigation is cancelled: a tab tap must not push a history entry. See
  // `App`'s `goTab` for why — a pushed entry hands the browser's back gesture
  // a destination, which is a second horizontal gesture with a different
  // meaning from the pager's.
  const picked: string[] = [];
  await render(
    <AppShell tab="agents" needsYou={0} onSelect={(k) => picked.push(k)}>
      <main className="screen">list</main>
    </AppShell>,
  );
  const spaces = [...document.querySelectorAll(".tab-item")]
    .find((a) => a.textContent?.includes("Spaces")) as HTMLElement;

  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  spaces.dispatchEvent(ev);
  await settle();

  expect(picked).toEqual(["spaces"]);
  expect(ev.defaultPrevented, "the tab tap was allowed to navigate").toBe(true);
});
