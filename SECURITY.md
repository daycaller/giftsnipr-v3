# Security audit status — Turn 7

## `npm audit` summary

```
8 vulnerabilities (5 low, 3 moderate)
0 high, 0 critical
```

### Why we don't fix them

All 8 are in **dev-time dependencies** that don't ship to production:

| Advisory | Severity | Package | Path | Why we keep it |
|---|---|---|---|---|
| Path traversal in `.map` handling | moderate | `vite@<6.4.2` | dev server only | Dev tool. Production is a static built bundle. |
| esbuild dev-server CORS | moderate | `esbuild@<=0.24.2` | dev server only | Same — only affects `npm run dev` |
| vite-plugin-node-polyfills | moderate | (transitive) | build-time | Wraps node-stdlib-browser; not at runtime |
| elliptic ECDSA primitive | low | (transitive via crypto-browserify) | bundled but unused | We use `@ton/crypto`'s ed25519 for signing; the elliptic-based ECDSA path is dead code in our hot paths |
| browserify-sign, create-ecdh | low | (transitive) | bundled but unused | Same as elliptic |

### The fix would break the build

`npm audit fix --force` would upgrade Vite from 5.x to 8.x. We tried this in Turn 1: Vite 8 ships with the Rolldown bundler, which fails to parse `@dedust/sdk`'s CJS axios dependency. Until DeDust ships ESM-first or Rolldown adds better CJS support, we're pinned to Vite 5.

### What ships to users

The production bundle contains:
- `@ton/core`, `@ton/ton`, `@ton/crypto` — actively used, no advisories
- `@tonconnect/ui` — actively used, no advisories
- `@dedust/sdk` — actively used, no advisories
- Bits of crypto-browserify polyfills (bundled by `vite-plugin-node-polyfills`)

The bundled polyfill code paths we actually call:
- `Buffer` from `buffer` (used for base64/hex encoding)
- That's it.

The vulnerable `elliptic` / `browserify-sign` / `create-ecdh` paths are dead code at runtime — our app never calls into them. They exist in the bundle as transitive imports the bundler can't tree-shake without a deeper refactor.

### What we did instead

1. **Pinned versions** in `package.json` — no surprise upgrades that could introduce new advisories
2. **CSP hardening** — `script-src` allows `'self' 'unsafe-inline' https://telegram.org`. The `'unsafe-inline'` is required because the gifts codebase uses inline `onclick="..."` handlers; migration to `addEventListener` is future work. XSS protection currently comes from strict use of `textContent` (never `innerHTML`) when building DOM from user/external data, not from CSP. `'unsafe-eval'` is not allowed.
3. **Added input validation** at every entry point — see `src/ton/swap.js` `composeBuy/composeSell` validators
4. **Wrote 50 real tests** covering swap composition, slippage math, BOC construction, and TEP-467 hash normalization — see `tests/swap.test.mjs`
5. **Verified the swap message format** with a boot-time BOC self-test that compares our hand-built swap body to what the DeDust SDK would produce, byte-for-byte
6. **Hardcoded + frozen the fee wallet address** so no runtime code (including malicious imports or DOM injection) can redirect fees

## When to revisit

- DeDust ships an ESM-first SDK → re-evaluate Vite 8 upgrade
- A high or critical advisory lands in a production dep → urgent
- We add a backend (Cloudflare Worker is fine, but a Node server expands attack surface) → re-audit

## Run the tests

```bash
node tests/swap.test.mjs
```

Expected: `ALL 50 TESTS PASSED`.
