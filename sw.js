/* DR Darre – service worker
   Guarda os arquivos do sistema no aparelho para o app abrir sem internet.
   Ao publicar uma versão nova, troque o número em VERSAO. */
const VERSAO = 'prdarre-3.2.0';
const ARQUIVOS = [
  './', './index.html', './css/estilo.css', './js/app.js', './vendor/qrcode.min.js', './manifest.webmanifest',
  './fonts/bodoni-moda-latin-500-normal.woff2', './fonts/bodoni-moda-latin-700-normal.woff2',
  './fonts/dm-sans-latin-400-normal.woff2', './fonts/dm-sans-latin-500-normal.woff2', './fonts/dm-sans-latin-700-normal.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-64.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSAO) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'atualizar') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // nuvem, WhatsApp etc. vão direto para a internet
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then(r => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});
