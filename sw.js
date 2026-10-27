// Web push for the page opened on its own (not inside a host app, which sends its own notifications).
// The engine's payload is {title, body, navigate, event_id}: a fixed title and where to open — never a date's content.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || "Ephemera", {
    body: d.body || "", tag: d.event_id ? `ephemera-${d.event_id}` : undefined, data: { navigate: d.navigate || null },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const nav = (e.notification.data && e.notification.data.navigate) || null;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) { await c.focus(); if (nav) c.postMessage({ ephemeraNavigate: nav }); return; }
    }
    const url = new URL(self.registration.scope);
    if (nav) url.searchParams.set("nav", JSON.stringify(nav));
    await self.clients.openWindow(url.href);
  })());
});
