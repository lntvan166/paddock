// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Settings } from "@web/components/Settings";
import { render, settle, unmount } from "./support/render";

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
  notify: { enabled: true, triggers: ["blocked"], quietHours: null, cooldownMs: 60_000 },
  publicUrl: null, error: null,
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
