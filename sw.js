// ==========================================
// RIDE2GETHER Service Worker (v3)
// ==========================================

const CACHE_NAME = 'ride2gether-v3';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap',
  'https://img.icons8.com/fluency-systems-filled/192/D4AF37/crown.png'
];

// 安裝 Service Worker 並快取核心靜態資源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] 正在預先快取核心資源...');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  // 強制跳過等待，立即啟用新版本
  self.skipWaiting();
});

// 啟動階段：清除舊版本的快取 (v1, v2 等舊版全部刪除)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[SW] 清除過期快取:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 網路攔截策略：Network First (優先走網路，失敗才走快取，確保費率與 API 不被死快取)
self.addEventListener('fetch', (event) => {
  // 如果是向 Google Apps Script 發送的 API 請求，完全不走快取，直接聯網
  if (event.request.url.includes('script.google.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // 請求成功則更新快取一份
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // 離線時才從快取讀取
        return caches.match(event.request);
      })
  );
});
