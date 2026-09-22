// ==========================================
// RIDE2GETHER Service Worker
// ==========================================

const CACHE_NAME = 'ride2gether-cache-v7.32';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './driver.html',
  './css/custom.css',
  './js/config.js',
  './functions/pricing.js',
  './js/rates.js',
  './js/profile.js',
  './js/map.js',
  './js/order.js',
  './js/account.js',
  './js/trip-motion.js',
  './js/trip-mirror.js',
  './js/driver.js',
  './js/app-mode.js',
  './js/chat.js',
  './js/tailwind-config.js',
  './manifest.json',
  './icon.svg',
  './assets/icons/mascot-chauffeur.svg',
  './assets/icons/mascot-vip-male.svg',
  './assets/icons/mascot-vip-female.svg',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js'
];

// 安裝 Service Worker 並快取核心靜態資源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] 正在預先快取核心資源...');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 啟動階段：清除所有非目前版本的快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache.startsWith('ride2gether-cache-') && cache !== CACHE_NAME) {
            console.log('[SW] 清除過期舊快取:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 網路攔截策略：Network First
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // 1. 即時連線排除：GAS、Firebase、Google Maps API 完全不走快取，直接聯網
  if (
    url.includes('script.google.com') ||
    url.includes('firestore.googleapis.com') ||
    url.includes('firebaseinstallations.googleapis.com') ||
    url.includes('identitytoolkit.googleapis.com') ||
    url.includes('securetoken.googleapis.com') ||
    url.includes('cloudfunctions.net') ||
    event.request.method !== 'GET' ||
    event.request.headers.has('Authorization') ||
    url.includes('maps.googleapis.com')
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. 靜態資源優先走網路，成功則更新快取，離線走快取兜底
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
