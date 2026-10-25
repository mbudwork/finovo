/* Finovo — service worker: push-уведомления и открытие кабинета по нажатию. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Finovo', {
    body: d.body || '', tag: d.tag || undefined, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  // адреса в уведомлениях вида '/#taxes' — относительно папки кабинета (работает и в /app/, и на поддомене)
  const url = new URL(String((e.notification.data && e.notification.data.url) || '/').replace(/^\//, ''), self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) { if ('navigate' in w) w.navigate(url); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
