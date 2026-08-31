/**
 * paddock's service worker. Notifications only.
 *
 * There is deliberately NO `fetch` handler, and that omission is the design:
 *
 * 1. paddock has no offline story, so a caching worker could only ever serve a
 *    stale app shell.
 * 2. docs/gotchas.md records that an expired Cloudflare Access session turns a
 *    service-worker fetch into an HTML login page rather than an error. A
 *    worker that never fetches cannot be fooled by it — which is what narrows
 *    that hazard to the TAP, where landing on an Access login is correct.
 *
 * tests/sw.test.ts asserts the absence. Do not add caching without reading
 * docs/decisions.md decision 23 first.
 *
 * ES5-flavoured and unbundled on purpose: this runs untranspiled in whatever
 * browser the phone brings, and it is not part of Vite's app graph.
 */

self.addEventListener("install", function () {
  // Take over promptly rather than waiting for every tab to close: a worker
  // that cannot ship a fix until the operator quits the app is a worker that
  // ships fixes never.
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch (e) {
    // Announced through the notification itself rather than swallowed. A push
    // that arrives and renders nothing is worse than a vague line: the
    // operator at least learns something happened.
    payload = null;
  }
  var title = payload && payload.name
    ? payload.name + " is " + payload.state
    : "paddock: an agent needs you";
  var agentId = (payload && payload.agentId) || "";

  // Replace by hand, because the tag alone does not.
  //
  // `tag` is supposed to make a second notification REPLACE the first, so one
  // agent can only ever hold one entry. Chrome honours that. Measured on iOS
  // 2026-08-27 it does not: an agent that went blocked and then reached a
  // second trigger left TWO entries, and both pushes carried the same tag.
  //
  // So the old entry is closed explicitly before the new one is shown — tag
  // replacement, done by hand. Filtered by tag and never blanket: closing
  // everything would throw away alerts this push knows nothing about. An
  // unreadable payload has no tag, so it closes nothing and still renders,
  // because that notification is the only trace of a real event.
  event.waitUntil(
    (agentId === ""
      ? Promise.resolve()
      : self.registration.getNotifications({ tag: agentId }).then(function (list) {
          for (var i = 0; i < list.length; i++) list[i].close();
        })
    ).then(function () {
      return self.registration.showNotification(title, {
        // One notification per agent — enforced above, not merely requested
        // here. The tag still matters: it is what the close-first step matches
        // on, and what a platform that DOES honour replacement would use.
        tag: agentId,
    // Same tag REPLACES rather than stacks. Left at its default `false`,
    // `renotify` means a replacement lands without alerting again — which is
    // the whole point when an agent has merely stopped being blocked and the
    // operator is not being told anything new enough to buzz for.
        renotify: false,
        data: { agentId: agentId },
      });
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var agentId = (event.notification.data && event.notification.data.agentId) || "";
  var target = "/#/agent/" + agentId;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      // Focus what is already open before opening a second one: on iOS this is
      // the whole point — the tap lands INSIDE the installed app rather than in
      // Safari, and a second window would defeat that.
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c && typeof c.focus === "function") {
          if (typeof c.navigate === "function") { c.navigate(target); }
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
