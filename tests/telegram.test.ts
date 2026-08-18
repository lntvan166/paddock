import { expect, test } from "bun:test";
import { sendTelegram } from "@server/notify/telegram";

const okBody = () => new Response(JSON.stringify({ ok: true }), {
  status: 200, headers: { "content-type": "application/json" },
});

test("posts the text as a JSON body, never a query string", async () => {
  let seen: { url: string; body: string } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), body: String(init.body) };
    return okBody();
  }) as unknown as typeof fetch;

  const r = await sendTelegram({ token: "123:ABC", chatId: "555",
                                 text: "api-refactor is blocked", fetchImpl });
  expect(r.ok).toBe(true);
  expect(seen!.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
  expect(seen!.url).not.toContain("api-refactor");   // never in the URL
  expect(JSON.parse(seen!.body)).toEqual({ chat_id: "555", text: "api-refactor is blocked" });
});

test("an application error arrives as ok:false inside a 200 and is surfaced verbatim", async () => {
  // "Bad Request: chat not found" tells the operator what to fix.
  // "send failed" does not.
  const fetchImpl = (async () => new Response(
    JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;

  const r = await sendTelegram({ token: "123:ABC", chatId: "bad", text: "x", fetchImpl });
  expect(r.ok).toBe(false);
  expect(r.detail).toBe("Bad Request: chat not found");
});

test("a hung request aborts rather than leaking a pending fetch per delta", async () => {
  const fetchImpl = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
    init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
  })) as unknown as typeof fetch;

  const r = await sendTelegram({ token: "1:A", chatId: "5", text: "x", fetchImpl, timeoutMs: 10 });
  expect(r.ok).toBe(false);
  expect(r.detail).toBeTruthy();
});
