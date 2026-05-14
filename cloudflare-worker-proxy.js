/**
 * GiftSnipr GeckoTerminal proxy — Cloudflare Worker
 * ===================================================
 *
 * Why: some browser/webview combos block direct calls to api.geckoterminal.com
 * because GeckoTerminal's CORS headers vary. This worker is a thin pass-through
 * that adds CORS headers so our app can always reach the data.
 *
 * Deploy steps:
 *   1. Sign up free at https://dash.cloudflare.com (no credit card needed)
 *   2. Workers → Create Worker → Quick Edit
 *   3. Paste this entire file as the worker source
 *   4. Click Save and Deploy
 *   5. Copy the worker URL (e.g. https://giftsnipr-gecko-proxy.your-name.workers.dev)
 *   6. In src/coins/gecko.js, change BASE to that URL
 *
 * Free tier: 100,000 requests/day. With our caching, this supports thousands
 * of daily active users comfortably.
 */

// Only allow these origins to use this proxy. Replace giftsnipr.com with
// your production domain. Wildcards (*.your-domain.com) are not supported
// by the CORS spec; list each explicitly.
const ALLOWED_ORIGINS = [
  'https://giftsnipr.com',
  'https://giftsnipr.netlify.app',
  'https://*.netlify.app',     // dev previews
  'https://*.github.dev',       // Codespaces
  // 'http://localhost:5173',   // uncomment for local dev only
];

const UPSTREAM = 'https://api.geckoterminal.com';

addEventListener('fetch', (event) => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  const origin = request.headers.get('Origin') || '';

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin),
    });
  }

  // Reject non-GET (the GeckoTerminal API is read-only)
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Reject if origin not whitelisted (defense against abuse of your free quota)
  if (!isAllowed(origin)) {
    return new Response('Origin not allowed', { status: 403 });
  }

  // Forward to GeckoTerminal
  const url = new URL(request.url);
  const upstreamUrl = UPSTREAM + url.pathname + url.search;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      // Cache for 60s at the edge so we don't hammer GT
      cf: { cacheTtl: 60, cacheEverything: true },
    });

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...corsHeaders(origin),
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    return new Response(`Upstream error: ${err.message}`, {
      status: 502,
      headers: corsHeaders(origin),
    });
  }
}

function corsHeaders(origin) {
  const allowOrigin = isAllowed(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function isAllowed(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(allowed => {
    if (allowed.includes('*')) {
      // Simple wildcard match: *.foo.com matches sub.foo.com
      const pattern = '^' + allowed.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$';
      return new RegExp(pattern).test(origin);
    }
    return origin === allowed;
  });
}
