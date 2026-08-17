import { useEffect, useState } from "react";
import {
  dismissInstall,
  installNow,
  readInstallEnv,
  shouldOfferInstall,
  type InstallPromptEvent,
} from "@web/install";

export function InstallHint() {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as unknown as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (hidden || !shouldOfferInstall(readInstallEnv(installEvent !== null))) return null;

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 text-[11px]"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
    >
      <span style={{ color: "var(--fg-dim)" }}>
        {installEvent
          ? "Install paddock for quicker access."
          : "Add to your home screen for quicker access."}
      </span>
      {installEvent && (
        <button
          type="button"
          className="tap rounded px-2 py-1"
          style={{ border: "1px solid var(--border)", color: "var(--fg)" }}
          onClick={() => {
            // The captured event can only be prompted once — hide after use
            // rather than leave a stale button around.
            installNow(installEvent);
            setHidden(true);
          }}
        >
          Install
        </button>
      )}
      <button
        type="button"
        className="tap ml-auto rounded px-2 py-1"
        style={{ border: "1px solid var(--border)", color: "var(--fg)" }}
        onClick={() => {
          dismissInstall();
          setHidden(true);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
