var CACHE_VERSION = 'v5';
var VAPID_PUBLIC_KEY = 'BIyHc2Q3XXbAYl1DgPRpqHZGJVM4i38ElcKYpeBib5RXVAUKSiG7IxZ-ZJPyt1UWokY_saRldY-CY54UXnvZbH8';

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

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

  var payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: 'Poker Manager', body: event.data.text() };
  }

  var title = payload.title || 'Poker Manager';
  var options = {
    body: payload.body || '',
    icon: '/poker.svg',
    badge: '/poker.svg',
    tag: payload.tag || ('poker-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)),
    data: { url: payload.url || '/' },
    dir: 'rtl',
    vibrate: [200, 100, 200],
    requireInteraction: false,
    renotify: true,
    silent: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('pushsubscriptionchange', function(event) {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: VAPID_PUBLIC_KEY,
    }).then(function() {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        clientList[i].postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' });
      }
    }).catch(function() {})
  );
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
