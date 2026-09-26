/* No fetch handler: API responses and private pages are never cached by this worker. */
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    /* Always show a visible notification. */
  }
  if (!payload || typeof payload !== "object") payload = {};
  event.waitUntil(
    self.registration.showNotification(
      typeof payload.title === "string"
        ? payload.title
        : "ETF Monitor 接続確認",
      {
        body:
          typeof payload.body === "string"
            ? payload.body
            : "テスト通知を受信しました。",
        icon: "/icon-192.png",
        badge: "/badge.svg",
        tag: typeof payload.tag === "string" ? payload.tag : "etf-validation",
        data: { url: typeof payload.url === "string" ? payload.url : "/" },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = new URL("/", self.location.origin);
  try {
    const requested = new URL(
      event.notification.data?.url || "/",
      self.location.origin,
    );
    if (
      requested.origin === self.location.origin &&
      /^https?:$/.test(requested.protocol) &&
      !requested.username &&
      !requested.password
    )
      target = requested;
  } catch {
    /* Invalid and external URLs fall back to this app. */
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find((client) => client.url === target.href);
      if (existing) return existing.focus();
      return self.clients.openWindow(target.href);
    })(),
  );
});
