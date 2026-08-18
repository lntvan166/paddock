export interface TelegramResult { ok: boolean; detail: string | null }

export interface SendOpts {
  token: string; chatId: string; text: string;
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
      body: JSON.stringify({ chat_id: o.chatId, text: o.text }),
      signal: ac.signal,
    });
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (body.ok === true) return { ok: true, detail: null };
    return { ok: false, detail: body.description ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
