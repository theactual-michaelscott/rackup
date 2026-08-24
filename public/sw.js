// Rack Up service worker — Web Push only.
// Registered by app/lib/push.js. Handles incoming push messages while the
// site isn't in the foreground and routes notification taps back into the app.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Rack Up', body: 'Someone you follow just checked in.', data: {} };

  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'Rack Up', body: event.data.text(), data: {} };
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Rack Up', {
      body: payload.body,
      data: payload.data || {},
      icon: '/icon.png',
      badge: '/icon.png',
      tag: payload.data?.checkInId ? `checkin-${payload.data.checkInId}` : undefined,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clientsList.find((client) => client.url.includes(self.location.origin));

      if (existing) {
        await existing.focus();
      } else {
        await self.clients.openWindow('/');
      }
    })()
  );
});
