/// CORS Proxy Service Worker
/// Intercepts cross-origin fetches that fail due to CORS and retries them
/// through a local dev proxy or public CORS proxy. Caches successful responses.

const CORS_PROXY = 'https://corsproxy.io/?';
const CACHE_NAME = 'cors-proxy-v2';
const CACHE_MAX_AGE = 60 * 60 * 1000; // 1 hour

// Domains we know need proxying (skip the direct attempt to save time)
const KNOWN_CORS_BLOCKED = [
  'undraw.co',
];

function shouldSkip(url) {
  try {
    const u = new URL(url);
    if (u.origin === self.location.origin) return true;
    if (u.protocol === 'data:') return true;
    if (u.protocol === 'blob:') return true;
    if (u.hostname === 'corsproxy.io') return true;
    if (u.hostname === 'api.iconify.design') return true;
    if (u.protocol === 'chrome-extension:') return true;
    return false;
  } catch {
    return true;
  }
}

function isKnownBlocked(url) {
  try {
    const hostname = new URL(url).hostname;
    return KNOWN_CORS_BLOCKED.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

function secureUrl(url) {
  return url.replace(/^http:\/\//, 'https://');
}

function getLocalProxyUrl(url) {
  return '/api/proxy-fetch?url=' + encodeURIComponent(url);
}

async function fetchWithCorsProxy(request) {
  const url = secureUrl(request.url);

  // Check cache first
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) {
    const cachedTime = cached.headers.get('x-sw-cached-at');
    if (cachedTime && (Date.now() - parseInt(cachedTime, 10)) < CACHE_MAX_AGE) {
      return cached;
    }
  }

  // For known-blocked domains, skip the direct attempt
  if (!isKnownBlocked(url)) {
    try {
      const directResp = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (directResp.ok) {
        const cloned = directResp.clone();
        const body = await cloned.arrayBuffer();
        const headers = new Headers(directResp.headers);
        headers.set('x-sw-cached-at', String(Date.now()));
        const cacheResp = new Response(body, {
          status: directResp.status,
          statusText: directResp.statusText,
          headers,
        });
        cache.put(url, cacheResp).catch(function() {});
        return directResp;
      }
    } catch (e) {
      // CORS error or network error - fall through to proxy
    }
  }

  // Try local dev server proxy first (same-origin, works through SSH tunnels)
  try {
    var localProxyUrl = getLocalProxyUrl(url);
    var localResp = await fetch(localProxyUrl);
    if (localResp.ok) {
      var body = await localResp.arrayBuffer();
      var contentType = localResp.headers.get('content-type') || 'application/octet-stream';
      var headers = new Headers({
        'Content-Type': contentType,
        'x-sw-cached-at': String(Date.now()),
        'x-sw-proxied': 'local',
      });
      var cleanResp = new Response(body, { status: 200, headers: headers });
      cache.put(url, cleanResp.clone()).catch(function() {});
      return cleanResp;
    }
  } catch (e) {
    // Local proxy not available - fall through to external proxy
  }

  // Proxy through corsproxy.io
  try {
    var proxyUrl = CORS_PROXY + encodeURIComponent(url);
    var proxyResp = await fetch(proxyUrl, { mode: 'cors', credentials: 'omit' });
    if (proxyResp.ok) {
      var body2 = await proxyResp.arrayBuffer();
      var contentType2 = proxyResp.headers.get('content-type') || 'application/octet-stream';
      var headers2 = new Headers({
        'Content-Type': contentType2,
        'x-sw-cached-at': String(Date.now()),
        'x-sw-proxied': 'true',
      });
      var cleanResp2 = new Response(body2, { status: 200, headers: headers2 });
      cache.put(url, cleanResp2.clone()).catch(function() {});
      return cleanResp2;
    }
  } catch (e) {
    // Proxy also failed
  }

  return new Response('CORS proxy failed', { status: 502, statusText: 'CORS Proxy Failed' });
}

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(name) { return name !== CACHE_NAME; })
             .map(function(name) { return caches.delete(name); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  if (shouldSkip(request.url)) return;
  event.respondWith(fetchWithCorsProxy(request));
});
