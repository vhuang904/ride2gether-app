// ==========================================
// RIDE2GETHER Service Worker (v4)
// ==========================================

const CACHE_NAME = 'ride2gether-v4';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap',
  'https://img.icons8.com/fluency-systems-filled/192/1E40AF/crown.png', // 換成皇家藍圖標
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js'
];

// 安裝 Service Worker 並快取核心靜態資源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] 正在預先快取藍白新版核心資源...');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 啟動階段：清除舊版本的快取 (v1, v2, v3 等舊版全部刪除)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
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

  // 1. 即時連線排除：GAS 與 Firebase 即時通道完全不走快取，直接聯網
  if (
    url.includes('script.google.com') ||
    url.includes('firestore.googleapis.com') ||
    url.includes('firebaseinstallations.googleapis.com')
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
