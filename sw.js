/* DR Darre – service worker
   Guarda os arquivos do sistema no aparelho para o app abrir sem internet.
   Com internet, o sistema sempre busca a versão mais nova primeiro (e só usa a guardada se a internet falhar ou demorar).
   Ao publicar uma versão nova, troque o número em VERSAO. */
const VERSAO = 'prdarre-3.20.0';
const ESPERA_MS = 4000;   // com internet lenta, abre a versão guardada depois de 4 segundos
let lentoAte = 0;           // depois de uma espera estourada, os próximos arquivos usam o guardado na hora (por 30 s)
const ARQUIVOS = [
  './', './index.html', './css/estilo.css', './js/app.js', './vendor/qrcode.min.js', './manifest.webmanifest',
  './fonts/bodoni-moda-latin-500-normal.woff2', './fonts/bodoni-moda-latin-700-normal.woff2',
  './fonts/dm-sans-latin-400-normal.woff2', './fonts/dm-sans-latin-500-normal.woff2', './fonts/dm-sans-latin-700-normal.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-64.png'
];
// arquivos que mudam a cada atualização: buscam o novo primeiro. O resto (fontes, ícones) vem direto do guardado.
const MUDAM = /\/(index\.html|css\/estilo\.css|js\/app\.js|manifest\.webmanifest|vendor\/qrcode\.min\.js)?$/;

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSAO) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'atualizar') self.skipWaiting(); });

// chave única por arquivo (sem ?v= e afins)
function chave(url) { const u = new URL(url); return new Request(u.origin + (u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname)); }

async function novoPrimeiro(e, req, k) {
  const cache = await caches.open(VERSAO);
  const rede = fetch(req.mode === 'navigate' ? k.url : req, { cache: 'no-cache' }).then(async r => {
    if (r && r.ok) await cache.put(k, r.clone());      // guarda a versão nova para a próxima vez sem internet
    return r;
  });
  const guardado = () => cache.match(k, { ignoreSearch: true });
  const lento = Date.now() < lentoAte;
  const espera = new Promise(res => setTimeout(() => res(null), lento ? 0 : ESPERA_MS));
  try {
    const r = await Promise.race([rede, espera]);
    if (r && r.ok) return r;
    const g = await guardado();
    if (g) { if (!lento) lentoAte = Date.now() + 30000; e.waitUntil(rede.catch(() => {})); return g; }   // internet lenta: abre o guardado e termina de baixar o novo
    return await rede;                                          // nada guardado ainda: espera a internet
  } catch {
    return (await guardado()) || Response.error();
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // nuvem, WhatsApp etc. vão direto para a internet
  if (url.pathname.endsWith('/sw.js')) return;                // o próprio sw.js o navegador atualiza sozinho
  if (req.mode === 'navigate' || MUDAM.test(url.pathname)) {
    e.respondWith(novoPrimeiro(e, req, chave(req.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : req.url)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});
