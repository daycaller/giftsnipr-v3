import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// ============================================================================
//  Vite build configuration for GiftSnipr
//
//  Why polyfills?  The TON SDKs (@ton/core, @ton/ton, @dedust/sdk) were
//  written for Node and use Buffer + a few other Node globals. The browser
//  doesn't have these, so we polyfill them.
//
//  Why target 'es2020'?  Telegram Mini Apps run in Telegram's in-app
//  browser which is a modern Chromium/WebKit. es2020 is safe and gives
//  us smaller bundles than es5.
//
//  Why the dynamic-manifest plugin?  The TonConnect manifest URL must match
//  the page origin. Production = giftsnipr.com. Codespaces preview =
//  something like https://abc-5173.app.github.dev. We rewrite the manifest
//  on every request so it always matches the current host.
// ============================================================================

function dynamicManifestPlugin() {
  return {
    name: 'giftsnipr-dynamic-manifest',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/tonconnect-manifest.json') return next();
        const host = req.headers.host || 'localhost:5173';
        // Codespaces / production both come through HTTPS;
        // local dev (npm run dev with no codespace) is http.
        const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
        const proto = isLocal ? 'http' : 'https';
        const origin = `${proto}://${host}`;
        const body = JSON.stringify({
          url: origin,
          name: 'GiftSnipr',
          iconUrl: `${origin}/icon-192.png`,
          termsOfUseUrl: `${origin}/terms.html`,
          privacyPolicyUrl: `${origin}/privacy.html`,
        });
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(body);
      });
    },
  };
}

export default defineConfig({
  plugins: [
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: false,
    }),
    dynamicManifestPlugin(),
  ],
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: {
          // Split large deps into their own chunks so the app shell loads fast.
          // Empty chunks for ton/dedust on Turn 2 will fill with real code in Turn 3+.
          'ton-vendor': ['@ton/core', '@ton/ton', '@ton/crypto'],
          'dedust-vendor': ['@dedust/sdk'],
          'tc-vendor': ['@tonconnect/ui'],
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',          // accessible from Codespaces port-forwarding
    port: 5173,
  },
});
