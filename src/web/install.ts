export interface InstallEnv {
  /** Already running as an installed app. */
  standalone: boolean;
  /** The browser fired `beforeinstallprompt`. */
  installEventSeen: boolean;
  /** iOS Safari, detected by capability shape — it never fires the install event. */
  iosSafari: boolean;
  dismissed: boolean;
}

/**
 * Gate on capability and install state ONLY. There is no device check anywhere:
 * offering a mobile-shaped button because of a user-agent guess is the bug this
 * replaces.
 */
export function shouldOfferInstall(env: InstallEnv): boolean {
  if (env.standalone || env.dismissed) return false;
  return env.installEventSeen || env.iosSafari;
}

const DISMISS_KEY = "paddock.install.dismissed";

export function readInstallEnv(installEventSeen: boolean): InstallEnv {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS exposes this non-standard flag on navigator when installed.
    (navigator as unknown as { standalone?: boolean }).standalone === true;

  // Feature-shaped test: a touch-capable WebKit that supports share but not the
  // install event. No user-agent string is parsed.
  const iosSafari =
    "share" in navigator &&
    "ontouchend" in document &&
    !("onbeforeinstallprompt" in window);

  return {
    standalone,
    installEventSeen,
    iosSafari,
    dismissed: localStorage.getItem(DISMISS_KEY) === "1",
  };
}

export function dismissInstall(): void {
  localStorage.setItem(DISMISS_KEY, "1");
}
