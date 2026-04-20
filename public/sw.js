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
  const url = typeof data.url === "string" ? data.url : "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/favicon.ico",
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        const absUrlObj = new URL(url, self.location.origin);
        // Reject navigation to external origins — push data could be tampered with.
        // Use origin comparison instead of string prefix to prevent bypasses via
        // userinfo (e.g. https://example.com@attacker.com/).
        if (absUrlObj.origin !== self.location.origin) {
          return clients.openWindow("/");
        }
        const absUrl = absUrlObj.href;
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            client.navigate(absUrl);
            return client.focus();
          }
        }
        return clients.openWindow(absUrl);
      })
  );
});
