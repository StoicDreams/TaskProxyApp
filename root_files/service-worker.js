self.addEventListener('install', event => event.waitUntil(onInstall(event)));
self.addEventListener('activate', event => event.waitUntil(onActivate(event)));
self.addEventListener('fetch', event => event.respondWith(onFetch(event)));
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
const currentVersion = `${get_uuid()}`;
console.log('Current version', currentVersion, location.host);
const cacheNamePrefix = 'offline-cache-';
const cacheName = `${cacheNamePrefix}${currentVersion}_ts_2503251820`;
const offlineAssetsInclude = [/\.wasm/, /\.html/, /\.js$/, /\.json$/, /\.css$/, /\.woff$/, /\.png$/, /\.jpe?g$/, /\.gif$/, /\.ico$/];
const offlineAssetsExclude = [/^service-worker\.js$/];

async function onInstall(event) {
    console.info(`Service worker: Install ${cacheName}`);
    self.skipWaiting();
}

async function onActivate(event) {
    console.info(`Service worker: Activate ${cacheName}`);

    // Delete unused caches
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys
        .filter(key => key.startsWith(cacheNamePrefix) && key !== cacheName)
        .map(key => caches.delete(key)));
}

async function onFetch(event) {
    let cachedResponse = null;
    let request = applyCacheBusting(event.request);
    if (allowCache(request)) {
        const cache = await caches.open(cacheName);
        cachedResponse = await cache.match(request);
    }

    return cachedResponse || fetch(request);
}

/// Applying cache busting to CDN content to assure Web UI components are always up to date with the latest changes.
function applyCacheBusting(request) {
    try {
        if (!request.url.startsWith('https://cdn.myfi.ws')) {
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
    // Only allow caching for GET requests
    if (request.method !== 'GET') { return false; }
    // Exclude caching for navigation requests to ensure the latest site updates are loaded asap
    if (request.mode === 'navigate') { return false; }
    // All other GET requests allow navigation
    return true;
}
