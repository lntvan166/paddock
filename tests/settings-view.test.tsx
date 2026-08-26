// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Settings } from "@web/components/Settings";
import { click, render, settle, typeInto, unmount } from "./support/render";

const realFetch = globalThis.fetch;
const PREF_KEYS = ["paddock.theme", "paddock.rate", "paddock.term.wrap", "paddock.term.fontpx"];

afterEach(async () => {
  await unmount();
  // A stub left installed leaks into every test file that runs after this
  // one; the prefs keys leak into tests/prefs.test.ts the same way (Bun runs
  // every test file in one process — see tests/support/dom.ts).
  globalThis.fetch = realFetch;
  for (const k of PREF_KEYS) localStorage.removeItem(k);
});

// Recognisable enough that a substring match cannot be an accident, and
// containing the literal word "secret" per ruling P7 so the assertion below
// is unambiguous about what it is guarding against.
const SECRET_TOKEN = "very-secret-token-9f21xyz";

const view = () => ({
  telegram: { configured: true, hint: "7f21", chatId: "555" },
  notify: { telegram: true, triggers: ["blocked"], settleMs: { blocked: 5_000, done: 10_000 },
            mutedUntil: null, cooldownMs: 60_000 },
  push: { enabled: false, devices: 0, vapidPublicKey: null, error: null },
  publicUrl: null, serverNow: 1_700_000_000_000, error: null,
});

test("the token is never rendered — only the hint", async () => {
  // The fixture below carries an extra `token` field the real GET response
  // never includes (server/routes.ts only ever serialises `settings.view()`,
  // which has no token member). It is here purely so this test is not
  // vacuously true: were the component ever to bind the input's value to
  // something from the fetched payload, this fixture is what would leak.
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ ...view(), telegram: { ...view().telegram, token: SECRET_TOKEN } }),
    { headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();

  expect(host.textContent).toContain("7f21");

  // Ruling P7: React does not set the `value` ATTRIBUTE on a controlled
  // input — it sets the DOM property. Asserting on getAttribute("value")
  // passes whether or not the token is rendered, which is worthless for the
  // single most important property in this task. Assert on the property.
  const input = host.querySelector('input[name="token"]') as HTMLInputElement | null;
  expect(input).not.toBeNull();
  expect(input?.value ?? "").toBe("");

  // And that the token never reaches the DOM by any other route either.
  expect(host.textContent).not.toContain(SECRET_TOKEN);
});

test("the global section says it affects every device", async () => {
  // A switch whose scope the operator must guess is a switch that gets misread:
  // turning notifications off on a phone also silences the laptop.
  globalThis.fetch = (async () => new Response(JSON.stringify(view()), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  expect(host.textContent?.toLowerCase()).toContain("every device");
});

test("the three bands are real headings, not just styled paragraphs", async () => {
  // "This device" writes to localStorage the instant a control is touched;
  // "All devices" is a form that does nothing until Save succeeds. Cards
  // inside each band carry their own `h3` title now (see Card.tsx), so if
  // the band label were merely a styled `<p>` — as it was before this
  // fix — a screen-reader user navigating by heading would meet every card
  // title as a top-level peer, with nothing above them saying which commit
  // model applies. Asserting `h2` here is what keeps that distinction
  // available to more than just sighted readers of the CSS.
  globalThis.fetch = (async () => new Response(JSON.stringify(view()), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  const headings = [...host.querySelectorAll("h2")].map((h) => h.textContent);
  expect(headings).toEqual(["This device", "All devices", "Info"]);
});

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!btn) throw new Error(`no button with text "${text}"`);
  return btn as HTMLButtonElement;
}

test("a failed save surfaces the server's rejection reason, never a silent failure", async () => {
  // The 400 `detail` is the whole point of server-side validation — a
  // generic "save failed" (or, worse, no message at all) would leave the
  // operator believing a switch is set when the server refused it.
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return new Response(
        JSON.stringify({ ok: false, detail: "cooldownMs must be a positive integer" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(view()), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();

  // The save bar — and its Save button — only exists once something is
  // dirty, so an edit is required before there is a button to click at all.
  const chatId = host.querySelector<HTMLInputElement>('input[name="chatId"]')!;
  await typeInto(chatId, "556");
  await settle();

  await click(buttonByText(host, "Save"));
  await settle();
  await settle();

  expect(host.textContent).toContain("cooldownMs must be a positive integer");
});

test("a failed test message surfaces Telegram's own description, never a silent failure", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("/telegram/test")) {
      return new Response(JSON.stringify({ ok: false, detail: "chat not found" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(view()), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();

  await click(buttonByText(host, "Send test message"));
  await settle();
  await settle();

  expect(host.textContent).toContain("chat not found");
});

test("a form that never loaded cannot be saved, so a failed GET cannot overwrite the server", async () => {
  // Every field in the "All devices" section starts at an empty/false/60000
  // placeholder and is only populated by the mount GET. If that GET fails,
  // `loadError` is shown — but a form that treated itself as editable would
  // let the operator "save" `enabled: false, triggers: [], chatId: null`
  // straight over whatever was actually configured. `baseline` stays null
  // when the GET fails, `dirty` stays false while `baseline === null`, and
  // the save bar renders nothing while the form is not dirty — so there is
  // no Save button on screen at all, not merely a disabled one.
  let puts = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") { puts += 1; return new Response("{}"); }
    throw new Error("network down");
  }) as unknown as typeof fetch;

  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();

  // The failure IS surfaced — this is not a silent degradation.
  expect(host.textContent).toContain("network down");

  expect(host.querySelector(".settings-save-bar")).toBeNull();
  expect(puts).toBe(0);
});

test("publicUrl and cooldownMs have real inputs, and both reach the PUT body", async () => {
  // Both round-tripped through state with no control at all: validated,
  // stored, and consumed by the notifier, but unsettable without hand-editing
  // settings.json. With publicUrl unset EVERY notification ships with no
  // link, which the design calls the whole reason the setting exists.
  let putBody: string | null = null;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      putBody = String(init.body);
      return new Response(JSON.stringify(view()), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(view()), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();

  const url = host.querySelector('input[name="publicUrl"]') as HTMLInputElement | null;
  expect(url).not.toBeNull();
  const cooldown = host.querySelector('input[name="cooldownMs"]') as HTMLInputElement | null;
  expect(cooldown).not.toBeNull();
  // The server's own floor (`MIN_COOLDOWN_MS`, in the settings store): 0 disarms the rate
  // limit and reintroduces the send-per-delta hot loop.
  expect(cooldown!.getAttribute("min")).toBe("1000");

  await typeInto(url!, "https://paddock.example.com");
  await typeInto(cooldown!, "90000");
  await settle();

  await click(buttonByText(host, "Save"));
  await settle();
  await settle();

  expect(putBody).not.toBe(null);
  const sent = JSON.parse(putBody!);
  expect(sent.publicUrl).toBe("https://paddock.example.com");
  expect(sent.notify.cooldownMs).toBe(90_000);
});

test("an existing publicUrl is shown in the field, not silently wiped on the next Save", async () => {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ ...view(), publicUrl: "https://paddock.example.com" }),
    { headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;

  const host = await render(<Settings onBack={() => {}} />);
  await settle();
  await settle();

  const url = host.querySelector('input[name="publicUrl"]') as HTMLInputElement;
  expect(url.value).toBe("https://paddock.example.com");
});
