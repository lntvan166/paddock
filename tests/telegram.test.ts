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

test("reply_markup is sent when given, and omitted when not", async () => {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  await sendTelegram({ token: "1:A", chatId: "555", text: "hi", fetchImpl });
  await sendTelegram({
    token: "1:A", chatId: "555", text: "hi", fetchImpl,
    replyMarkup: { inline_keyboard: [[{ text: "Open in paddock", url: "https://paddock.example.com/#/agent/w1%3Ap1" }]] },
  });

  expect("reply_markup" in (bodies[0] as object)).toBe(false);
  expect((bodies[1] as { reply_markup: unknown }).reply_markup).toEqual({
    inline_keyboard: [[{ text: "Open in paddock", url: "https://paddock.example.com/#/agent/w1%3Ap1" }]],
  });
});
