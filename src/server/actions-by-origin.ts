/**
 * One `HerdrActions` over both backends. Each call goes to the backend that
 * owns its first id argument: a core id (`hc.…`) to herdr-core, anything else
 * to terminal herdr. Ids never cross: a herdr id typed into the core, or the
 * reverse, would act on the wrong terminal.
 *
 * Knows neither backend — it only routes. A missing backend is a
 * `BackendUnavailable` the routes turn into a 503 naming it.
 */
import type { CreateOpts, HerdrActions } from "@server/herdr/actions";
import { BackendUnavailable } from "@server/action-errors";
import { isCoreId } from "@shared/origin";

export const CORE_DOWN = "herdr-core is not running";
export const HERDR_DOWN = "terminal herdr is not running";

export function actionsByOrigin(
  herdr: HerdrActions | undefined,
  core: HerdrActions | undefined,
): HerdrActions {
  const forCore = (): HerdrActions => {
    if (!core) throw new BackendUnavailable(CORE_DOWN);
    return core;
  };
  const forHerdr = (): HerdrActions => {
    if (!herdr) throw new BackendUnavailable(HERDR_DOWN);
    return herdr;
  };
  const by = (id: string): HerdrActions => (isCoreId(id) ? forCore() : forHerdr());
  /** Whether the "offering the core's kinds only" line has been said for the
   *  current stretch of terminal herdr being down. */
  let herdrFallbackSaid = false;

  return {
    readOutput: async (target, state, lines, scrollback) => by(target).readOutput(target, state, lines, scrollback),
    readPane: async (paneId) => by(paneId).readPane(paneId),
    readPromptScreen: async (target) => by(target).readPromptScreen(target),
    sendOptionKey: async (target, key) => by(target).sendOptionKey(target, key),
    sendNavKey: async (target, key) => by(target).sendNavKey(target, key),
    sendChars: async (target, chars) => by(target).sendChars(target, chars),
    sendReply: async (target, text) => by(target).sendReply(target, text),
    sendPaneText: async (paneId, text) => by(paneId).sendPaneText(paneId, text),
    sendPaneKey: async (paneId, key) => by(paneId).sendPaneKey(paneId, key),
    waitUntilUnblocked: async (target, timeoutMs) => by(target).waitUntilUnblocked(target, timeoutMs),
    renameAgent: async (target, name) => by(target).renameAgent(target, name),
    renameTab: async (tabId, label) => by(tabId).renameTab(tabId, label),
    renameSpace: async (spaceId, label) => by(spaceId).renameSpace(spaceId, label),
    closeTab: async (tabId) => by(tabId).closeTab(tabId),
    closeSpace: async (spaceId) => by(spaceId).closeSpace(spaceId),
    createTab: async (spaceId, opts) => by(spaceId).createTab(spaceId, opts),
    startAgent: async (paneId, kind, name, args) => by(paneId).startAgent(paneId, kind, name, args),
    markSeen: async (target, turn) => by(target).markSeen(target, turn),
    promptAllowed: async (target) => by(target).promptAllowed(target),

    // A new space has no id yet: the caller names the backend. Absent means
    // terminal herdr, which is what every existing caller meant.
    createSpace: async (opts: CreateOpts) =>
      (opts.origin === "core" ? forCore() : forHerdr()).createSpace(opts),

    /**
     * Both backends' kinds, herdr's first. Either side may be down: the other
     * side's list is then the whole list, so app-only operation still offers
     * the core's templates and a TUI-only setup still offers terminal herdr's.
     * Terminal herdr's list is required when herdr is up (its failure is the
     * failure, as before); the core only ADDS, so a core that is failing never
     * takes the TUI's create sheet with it. A core failure other than "not
     * running" is said at INFO rather than dropped, and so is falling back to
     * the core alone — once per stretch of herdr being down, not per call.
     */
    harnessKinds: async () => {
      let kinds: string[];
      try {
        kinds = await forHerdr().harnessKinds();
        herdrFallbackSaid = false;
      } catch (e) {
        if (!(e instanceof BackendUnavailable) || !core) throw e;
        if (!herdrFallbackSaid) {
          console.info(`paddock: ${e.message}; offering herdr-core's harness kinds only`);
          herdrFallbackSaid = true;
        }
        return core.harnessKinds();
      }
      if (!core) return kinds;
      let extra: string[] = [];
      try {
        extra = await core.harnessKinds();
      } catch (e) {
        if (!(e instanceof BackendUnavailable)) {
          console.info(`herdr-core: templates unavailable (${(e as Error).message}); offering terminal herdr's kinds only`);
        }
      }
      return [...kinds, ...extra.filter((k) => !kinds.includes(k))];
    },
  };
}

/**
 * Terminal herdr's actions, refused while it is not connected.
 *
 * The composition root always HAS terminal herdr's actions — they are just a
 * socket path — so without this a herdr that is not running reached every
 * caller as a socket error: a 502 instead of the 503 that names it, and, worse,
 * app-only `harnessKinds` failing outright instead of falling back to the
 * core's list. This is the herdr twin of `requireCore`: the backend answers
 * "is it up?" per call, so a herdr that comes back needs no rewiring.
 */
export function requireHerdr(actions: HerdrActions, connected: () => boolean): HerdrActions {
  return new Proxy(actions, {
    get(target, name, receiver) {
      const v = Reflect.get(target, name, receiver) as unknown;
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        if (!connected()) throw new BackendUnavailable(HERDR_DOWN);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
