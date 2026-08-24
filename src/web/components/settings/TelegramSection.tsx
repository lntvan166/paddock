import { Card } from "@web/components/ui/Card";
import { SendIcon } from "@web/components/ui/icons";

interface TelegramSectionProps {
  token: string; setToken: (v: string) => void;
  chatId: string; setChatId: (v: string) => void;
  tokenPlaceholder: string;
  testing: boolean;
  testResult: { ok: boolean; detail: string | null } | null;
  onTest: () => void;
}

export function TelegramSection({
  token, setToken, chatId, setChatId, tokenPlaceholder, testing, testResult, onTest,
}: TelegramSectionProps) {
  return (
    <Card icon={<SendIcon />} title="Telegram" subtitle="The bot that delivers them.">
      <label className="card-row">
        <span>Telegram token</span>
        <input
          type="password"
          name="token"
          value={token}
          autoComplete="off"
          placeholder={tokenPlaceholder}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {/* The placeholder attribute alone is not enough: it never shows
          while the field has focus, and a placeholder is not something
          an operator can screenshot-search or a test can rely on being
          painted. This status line is the same string, rendered as
          actual text. */}
      <span className="settings-token-status">{tokenPlaceholder}</span>

      <label className="card-row">
        <span>Chat id</span>
        <input
          type="text"
          name="chatId"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
        />
      </label>

      <div className="settings-actions">
        <button type="button" onClick={onTest} disabled={testing}>
          {testing ? "Sending…" : "Send test message"}
        </button>
      </div>

      {testResult && (
        <p className={testResult.ok ? "settings-ok" : "settings-banner"}>
          {testResult.ok ? "Test message sent." : testResult.detail}
        </p>
      )}
    </Card>
  );
}
