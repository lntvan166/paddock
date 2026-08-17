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
    dismissed: readDismissed(),
  };
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    // localStorage access can throw outright — Safari private mode throws on
    // write, and an enterprise policy or blocked-storage setting can throw a
    // SecurityError on mere property access. Fail open: a hint that
    // reappears next session is a trivial annoyance; a crashed dashboard
    // (this read happens in render) is not.
    return false;
  }
}

export function dismissInstall(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Best-effort only — see readDismissed above.
  }
}

/**
 * The `beforeinstallprompt` event's shape. Not declared in lib.dom.d.ts, so we
 * name only the member we use.
 */
export interface InstallPromptEvent {
  prompt(): void | Promise<void>;
}

/** Trigger the browser's native install dialog from a captured event. */
export function installNow(event: InstallPromptEvent | null): void {
  event?.prompt();
}
