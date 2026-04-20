var CACHE_VERSION = 'v2';

// On install: skip waiting so the new SW activates immediately
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

// On activate: clear all old caches and take control of all clients
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.map(function(name) { return caches.delete(name); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('push', function(event) {
  if (!event.data) return;

  try {
    var payload = event.data.json();
    var title = payload.title || 'Poker Manager';
    var options = {
      body: payload.body || '',
      icon: '/poker.svg',
      badge: '/poker.svg',
      tag: payload.tag || 'poker-notification',
      data: { url: payload.url || '/' },
      dir: 'rtl',
      vibrate: [200, 100, 200],
      requireInteraction: false,
      renotify: true,
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    var text = event.data.text();
    event.waitUntil(
      self.registration.showNotification('Poker Manager', {
        body: text,
        icon: '/poker.svg',
        dir: 'rtl',
      })
    );
  }
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.includes(self.location.origin) && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
