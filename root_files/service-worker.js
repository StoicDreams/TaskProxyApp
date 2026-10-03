self.addEventListener('install', event => event.waitUntil(onInstall(event)));
self.addEventListener('activate', event => event.waitUntil(onActivate(event)));
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (
        url.protocol === 'ipc:' ||
        url.protocol === 'tauri:' ||
        url.hostname === 'ipc.localhost' ||
        url.hostname === 'tauri.localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === 'localhost'
    ) {
        return;
    }
    if (!event.request.url.startsWith('http')) {
        return;
    }
    event.respondWith(onFetch(event))
});
function get_uuid() {
    try {
        return crypto.randomUUID();
    } catch (ex) {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            let r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
}
const currentVersion = '0.1.40';
const cacheNamePrefix = 'offline-cache-';
const cacheName = `${cacheNamePrefix}${currentVersion}`;
async function onInstall(event) {
    self.skipWaiting();
}
async function onActivate(event) {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys
        .filter(key => key.startsWith(cacheNamePrefix) && key !== cacheName)
        .map(key => caches.delete(key)));
    await self.clients.claim();
}

async function onFetch(event) {
    let request = applyCacheBusting(event.request);
    if (!allowCache(request)) {
        return fetch(request);
    }
    const cache = await caches.open(cacheName);
    const cachedResponse = await cache.match(request);
    const networkFetchPromise = fetch(request).then(networkResponse => {
        if (networkResponse && networkResponse.ok) {
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    }).catch(error => {
        console.error('Background fetch failed:', error);
    });
    if (cachedResponse) {
        event.waitUntil(networkFetchPromise);
        return cachedResponse;
    }
    return networkFetchPromise;
}
function urlNeedsCaching(url) {
    if (url.startsWith('https://cdn.myfi.ws')) return false;
    if (url.startsWith('http://127.0.0.1:1426')) return false;
    return true;
}
function applyCacheBusting(request) {
    try {
        if (urlNeedsCaching(request.url)) {
            return request;
        }
        const url = new URL(request.url);
        url.searchParams.set('_', cacheName);
        return new Request(url.toString(), request);
    } catch {
        return request;
    }
}
function allowCache(request) {
    if (request.method !== 'GET') { return false; }
    if (request.mode === 'navigate') { return false; }
    return true;
}
