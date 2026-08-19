import type { InlineKeyboard } from "@shared/types";

export interface TelegramResult { ok: boolean; detail: string | null }

export interface SendOpts {
  token: string; chatId: string; text: string;
  /** Omitted from the body entirely when absent — Telegram rejects a null. */
  replyMarkup?: InlineKeyboard;
  fetchImpl?: typeof fetch; timeoutMs?: number;
}

/**
 * One HTTPS POST. Transport only — every policy decision lives in notifier.ts.
 *
 * Plain text with NO parse_mode: agent names originate in herdr and may carry
 * Markdown or HTML metacharacters. With no parse mode there is nothing to
 * escape and no way for a name to corrupt or inject into the message.
 */
export async function sendTelegram(o: SendOpts): Promise<TelegramResult> {
  const f = o.fetchImpl ?? fetch;
  const ac = new AbortController();
  // Unbounded, this leaks one pending request per delta against a black hole.
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 10_000);
  try {
    const res = await f(`https://api.telegram.org/bot${o.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: o.chatId,
        text: o.text,
        ...(o.replyMarkup ? { reply_markup: o.replyMarkup } : {}),
      }),
      signal: ac.signal,
    });
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (body.ok === true) return { ok: true, detail: null };
    return { ok: false, detail: body.description ?? `HTTP ${res.status}` };
  } catch (e) {
    // `(e as Error).message` ONLY — never the error object, never `e.cause`,
    // never a JSON.stringify of it. Bun attaches the request `url` to a fetch
    // error, and this URL contains the bot token
    // (`api.telegram.org/bot<token>/sendMessage`). This string is handed
    // straight to the notifier's `lastError`, which `/api/health` publishes
    // and the settings view renders — so serialising the error, or walking
    // its `cause` chain to "get more detail", would leak the one credential
    // the design says is never logged at any level. A future sweep that
    // unifies the project's error idiom must leave this call site alone.
    return { ok: false, detail: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
