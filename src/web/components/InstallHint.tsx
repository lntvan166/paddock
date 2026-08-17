import { useEffect, useState } from "react";
import { dismissInstall, readInstallEnv, shouldOfferInstall } from "@web/install";

export function InstallHint() {
  const [eventSeen, setEventSeen] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEventSeen(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (hidden || !shouldOfferInstall(readInstallEnv(eventSeen))) return null;

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 text-[11px]"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}
    >
      <span style={{ color: "var(--fg-dim)" }}>Add to your home screen for quicker access.</span>
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
