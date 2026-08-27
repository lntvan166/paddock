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

  // A push whose job is to CLOSE a notification that has stopped being true.
  //
  // OFF by default and gated server-side behind PADDOCK_CLEAR_PUSH=1, because
  // it renders nothing and so breaks the `userVisibleOnly: true` promise the
  // subscription was made under. It worked, and then push stopped delivering
  // entirely on that endpoint; a fresh subscription with identical code and
  // key delivered fine. See architecture.md. The replacement path below does
  // the same job without the breach.
  //
  // An untagged clear is ignored rather than guessed at: with no tag there is
  // nothing to identify, and closing everything would throw away alerts this
  // push knows nothing about.
  if (payload && payload.clear === true) {
    if (agentId === "") return;
    event.waitUntil(
      self.registration.getNotifications({ tag: agentId }).then(function (list) {
        for (var i = 0; i < list.length; i++) list[i].close();
      })
    );
    return;
  }

  // Replace by hand, because the tag alone does not.
  //
  // `tag` is supposed to make a second notification REPLACE the first. Chrome
  // honours that. Measured on iOS 2026-08-27: it does not — an agent going
  // blocked and then working left TWO entries in Notification Center, a stale
  // one and a true one, which is worse than the single stale entry we started
  // with. Both pushes carried the same tag; the server log shows it.
  //
  // So the old entry is closed explicitly before the new one is shown. This is
  // what tag replacement was supposed to do, done manually. It still calls
  // `showNotification`, so unlike the clear experiment it honours
  // `userVisibleOnly: true` and cannot earn the penalty that cost a live
  // subscription.
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
