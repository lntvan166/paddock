import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateVapidKeys, type VapidKeys } from "@server/push/vapid";

/**
 * `push.json` — the VAPID keypair and the subscribed devices.
 *
 * NOT `settings.json`, and the distinction is one paddock already draws:
 * `settings.json` is documented in docs/settings.md and meant to be
 * hand-edited, while `paddock.state.json` and `update-check.json` are written
 * by paddock and read by nobody. A VAPID private key is never user-facing and a
 * device list is a growing record — both are STATE, not config. The Telegram
 * token is precedent for a secret in settings, but a token is something a
 * person pastes IN, and the file users are told to edit is the file they will
 * paste into an issue.
 */

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface FileShape {
  keys: VapidKeys;
  subscriptions: StoredSubscription[];
}

/**
 * An fs failure's REASON, with no path in it.
 *
 * Node's `Error.message` for a filesystem call is
 * `EACCES: permission denied, open '/home/<user>/.config/paddock/push.json'` —
 * the errno, a description, and the ABSOLUTE PATH. This warning is surfaced in
 * the Settings UI, so forwarding `.message` verbatim printed the operator's
 * home directory on screen, where a README screenshot would capture it as
 * pixels that `check-clean` cannot scan.
 *
 * The errno code and its description are what an operator can act on; the path
 * is one they already know. So the code is kept and the path dropped, and a
 * non-errno failure falls back to its own message with any quoted path
 * stripped rather than being replaced by something vaguer than the truth.
 */
export function errnoReason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  const msg = e instanceof Error ? e.message : String(e);
  // Anything inside single quotes is a path in every message this can see.
  return msg.replace(/'[^']*'/g, "").replace(/,\s*$/, "").trim() || "unknown error";
}

export class PushStore {
  readonly error: string | null;
  readonly #dir: string;
  #keys: VapidKeys | null;
  #subs: StoredSubscription[];

  private constructor(
    dir: string, keys: VapidKeys | null, subs: StoredSubscription[], error: string | null,
  ) {
    this.#dir = dir;
    this.#keys = keys;
    this.#subs = subs;
    this.error = error;
  }

  static #file(dir: string): string { return join(dir, "push.json"); }

  /**
   * Read the store, or explain why push is off.
   *
   * THE rule of this file: a keypair is generated ONCE, and never silently
   * regenerated. A fresh keypair invalidates every subscription in existence
   * and the failure has no symptom — every phone simply stops buzzing, with
   * nothing on any screen to explain it. So an unreadable file disables push
   * and says so; it does not mint a replacement, and it does not overwrite what
   * it could not read, because that file is the only way back.
   */
  static async load(dir: string): Promise<PushStore> {
    let raw: string;
    try {
      raw = await readFile(PushStore.#file(dir), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        // The ordinary first run: no file yet, so mint the one keypair this
        // install will ever have.
        try {
          const keys = await generateVapidKeys();
          const store = new PushStore(dir, keys, [], null);
          await store.#save();
          return store;
        } catch (writeErr) {
          // The REASON, never the raw errno string. Node puts the absolute
          // path in `.message` — `ENOENT: ... open '/home/<user>/.config/
          // paddock/push.json'` — and this warning is rendered in the Settings
          // UI, so it put the operator's home directory on screen. That is the
          // one thing this repo's first rule forbids anywhere, and neither
          // `check-clean` nor any test can catch it: it is runtime text, and it
          // would reach a README screenshot as pixels.
          return new PushStore(
            dir, null, [],
            `push.json could not be created in the config directory (${errnoReason(writeErr)}) — push is off`,
          );
        }
      }
      // Same reasoning as the create failure above: reason, not raw errno.
      return new PushStore(
        dir, null, [], `push.json is unreadable (${errnoReason(e)}) — push is off`,
      );
    }

    try {
      const parsed = JSON.parse(raw) as FileShape;
      if (parsed.keys?.publicKey === undefined || parsed.keys?.privateKey === undefined) {
        return new PushStore(
          dir, null, [],
          "push.json has no VAPID keypair — push is off until it is repaired or removed",
        );
      }
      return new PushStore(dir, parsed.keys, parsed.subscriptions ?? [], null);
    } catch (e) {
      return new PushStore(
        dir, null, [],
        `push.json is not valid JSON, so push is off and the file is left alone: ${(e as Error).message}`,
      );
    }
  }

  publicKey(): string | null { return this.#keys?.publicKey ?? null; }
  keys(): VapidKeys | null { return this.#keys; }
  list(): StoredSubscription[] { return [...this.#subs]; }

  /** Keyed by endpoint: a browser re-subscribing after a permission reset
   *  reuses its endpoint with fresh keys, and two records would send every
   *  notification twice. */
  async add(s: StoredSubscription): Promise<void> {
    this.#subs = [...this.#subs.filter((x) => x.endpoint !== s.endpoint), s];
    await this.#save();
  }

  async remove(endpoint: string): Promise<void> {
    this.#subs = this.#subs.filter((x) => x.endpoint !== endpoint);
    await this.#save();
  }

  async #save(): Promise<void> {
    if (this.#keys === null) return;
    const body: FileShape = { keys: this.#keys, subscriptions: this.#subs };
    // 0600 from the moment it exists: this file holds a private key.
    await writeFile(PushStore.#file(this.#dir), JSON.stringify(body, null, 2), { mode: 0o600 });
  }
}
