/**
 * The two refusals an action can give that are NOT a backend failure.
 *
 * Neutral ground on purpose: terminal herdr's actions, herdr-core's actions,
 * the app socket client and the routes all use them, and none of those may
 * import another's backend directory. `routes.ts` turns them into HTTP
 * statuses (`failStatus`): a 409 for `Unsupported`, a 503 for
 * `BackendUnavailable`, and every other error stays the 502 it always was.
 */

/** The operation cannot be done here or right now; the message says what to do. */
export class Unsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unsupported";
  }
}

/** The backend that owns this id is not running ("herdr-core is not running"). */
export class BackendUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailable";
  }
}
