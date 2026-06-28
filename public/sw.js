// Base path of the deployment, derived from the registration scope (e.g. "/request"
// under BASE_PATH=/request, or "" at the origin root). Used to keep the notification
// icon and default navigation target inside the app subtree behind a reverse proxy.
function basePath() {
  try {
    const scopePath = new URL(self.registration.scope).pathname;
    return scopePath === "/" ? "" : scopePath.replace(/\/$/, "");
  } catch {
    return "";
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: "Summonarr", body: event.data?.text() ?? "" };
  }

  const rawTitle = typeof data.title === "string" ? data.title : "Summonarr";
  const rawBody = typeof data.body === "string" ? data.body : "";
  const title = rawTitle.slice(0, 200) || "Summonarr";
  const body = rawBody.slice(0, 1000);
  const base = basePath();
  const url = typeof data.url === "string" ? data.url : `${base}/`;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: `${base}/favicon.ico`,
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const base = basePath();
  const rawUrl = event.notification.data?.url ?? `${base}/`;
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        let absUrlObj;
        try {
          absUrlObj = new URL(rawUrl, self.location.origin);
        } catch {
          // Malformed url in tampered push data — fall back to the app root.
          return clients.openWindow(`${base}/`);
        }
        // Reject navigation to external origins — push data could be tampered with.
        // Use origin comparison instead of string prefix to prevent bypasses via
        // userinfo (e.g. https://example.com@attacker.com/).
        if (absUrlObj.origin !== self.location.origin) {
          return clients.openWindow(`${base}/`);
        }
        const absUrl = absUrlObj.href;
        for (const client of windowClients) {
          // Origin comparison (not a substring match) when picking a window to
          // reuse, mirroring the navigation-target check above.
          let clientOrigin;
          try {
            clientOrigin = new URL(client.url).origin;
          } catch {
            continue;
          }
          if (clientOrigin === self.location.origin && "focus" in client) {
            // client.navigate isn't supported in every browser — fall back to
            // opening a fresh window when it's unavailable.
            if (typeof client.navigate === "function") {
              return client.navigate(absUrl).then(() => client.focus());
            }
            return client.focus();
          }
        }
        return clients.openWindow(absUrl);
      })
  );
});
