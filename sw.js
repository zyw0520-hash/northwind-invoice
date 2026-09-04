const VERSION = 'invoice-v20';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/ai.js',
  './lib/dexie.min.js',
  './lib/pdf.min.js',
  './lib/pdf.worker.min.js',
  './js/app.js',
  './js/db.js',
  './js/models.js',
  './js/pdfParse.js',
  './js/sentinels.js',
  './js/sync.js',
  './js/backup.js',
  './js/csv.js',
  './js/dialog.js',
  './js/seed.js',
  './js/views/dashboard.js',
  './js/views/documents.js',
  './js/views/leads.js',
  './js/views/suppliers.js',
  './js/views/settings.js',
  './js/tests/selftest.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Supabase API：只走网络
  if (url.hostname.endsWith('.supabase.co')) return;

  // 应用代码（js/css，不含 lib）：网络优先——上传新文件后普通刷新一次即生效；离线回退缓存
  if (url.origin === location.origin && /\.(js|css)$/i.test(url.pathname) && !url.pathname.includes('/lib/')) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // 其他本地资源（页面/lib/图标）：cache-first，后台刷新
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetching = fetch(e.request).then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy));
          return res;
        }).catch(() => cached);
        return cached || fetching;
      })
    );
  }
});
