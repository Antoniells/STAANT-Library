// Service Worker do STAANT — cache-first pro "esqueleto" do app (HTML/CSS/JS/CDNs),
// pra abrir instantâneo mesmo sem rede. Os arquivos pesados dos livros NÃO passam por
// aqui: ficam no IndexedDB (offline-books.js), baixados só quando o usuário pede.
const CACHE_NAME = 'staant-shell-v6';

const SHELL_ASSETS = [
    './',
    './index.html',
    './reader.html',
    './login.html',
    './register.html',
    './forgot-password.html',
    './404.html',
    './manifest.json',
    './firebase-config.js',
    './supabase-config.js',
    './offline-books.js',
    './reading-stats.js',
    './icons/icon-50.png',
    './icons/icon-150.png',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './css/index.css',
    './css/reader.css',
    './css/login.css',
    './css/register.css',
    './css/forgot-password.css',
    './css/404.css',
    './js/index.js',
    './js/book-reorder.js',
    './js/reader.js',
    './js/login.js',
    './js/login-redirect.js',
    './js/register.js',
    './js/forgot-password.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .catch((err) => console.warn('SW: falha ao pré-cachear o shell', err))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Nunca cachear: Firestore, Storage do Supabase e o proxy de descoberta — precisam
// estar sempre frescos (dados dinâmicos, não fazem parte do "esqueleto" do app).
function isNeverCache(url) {
    return url.hostname.includes('firestore.googleapis.com')
        || url.hostname.includes('googleapis.com')
        || url.hostname.includes('supabase.co')
        || url.hostname.includes('staant-proxy.vercel.app');
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (isNeverCache(url)) return; // deixa passar direto pra rede, sem interceptar

    // Cache-first com atualização em segundo plano: responde na hora com o que já
    // tem guardado (abertura instantânea) e, se der rede, atualiza o cache pra próxima.
    event.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req).then((res) => {
                if (res && (res.ok || res.type === 'opaque')) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                }
                return res;
            }).catch(() => cached);
            return cached || network;
        })
    );
});
