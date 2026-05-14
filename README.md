# 🎯 GiftSnipr v0.3 — Turn 2 (Gifts Migration + COINS Toggle)

The full production gifts app is now running inside the bundled Vite project,
with a new top-level **GIFTS / COINS** mode toggle. COINS shows a placeholder
that becomes the real memecoin sniper in Turn 3.

**Your production `giftsnipr.com` is untouched.** Everything below runs only
in Codespaces or on a separate preview Netlify until you explicitly say ship.

---

## What's new in Turn 2

- ✅ Entire production gifts app migrated into bundled ES modules
- ✅ TonConnect UI now loaded via `import` instead of unpkg CDN
- ✅ Top GIFTS/COINS mode toggle (sticky header, animated)
- ✅ COINS placeholder pane with feature list
- ✅ Dynamic TonConnect manifest (works on Codespaces preview URLs automatically)
- ✅ All existing features preserved: wallet, profile, claim, badges, BETA banner, etc.
- ✅ Production build succeeds (~1.6MB total, 450KB gzipped)
- ✅ Smoke tests pass (12/12 structural checks)
- ✅ Security audit clean for production paths

---

## Setup on Codespaces (one time)

### 1. Push this to a GitHub repo

If you haven't already:
1. Create a new private repo on github.com named `giftsnipr-v3`
2. Unzip this folder
3. Use GitHub Desktop OR run these commands:
   ```
   git init
   git add .
   git commit -m "Turn 2 — migrated gifts to bundled project + COINS toggle"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/giftsnipr-v3.git
   git push -u origin main
   ```

### 2. Open in Codespaces

1. Go to your repo on github.com
2. Green **Code** button → **Codespaces** tab → **Create codespace on main**
3. Wait ~60 seconds while it installs (auto-runs `npm install` thanks to `.devcontainer/`)

### 3. Start the dev server

In the Codespaces terminal at the bottom:
```
npm run dev
```

A popup appears: **"Your application running on port 5173 is available."**
Click **Open in Browser**.

The URL will look like: `https://YOUR-CODESPACE-12345-5173.app.github.dev`

---

## Preview on iPhone

There are two ways to preview the app on your iPhone:

### Option A — Codespaces forwarded port (best for active development)

1. In Codespaces, after running `npm run dev`, click the **PORTS** tab at the bottom
2. Find port 5173 → right-click → **Port Visibility** → **Public**
3. Copy the forwarded URL (the one ending in `.app.github.dev`)
4. Open that URL in **Safari on your iPhone**

Notes:
- The URL changes every time you restart the Codespace.
- Live reload works — any code change reflects immediately.
- The TonConnect manifest is served dynamically and will match this URL, so wallet connect works correctly.

### Option B — Netlify preview deploy (best for stable demos)

1. In Codespaces terminal: `npm run build`
2. Right-click the new `dist/` folder in the file explorer → **Download**
3. Drag the downloaded `dist/` to a *new, separate* Netlify site (NOT your production `giftsnipr.com`). Name it something like `giftsnipr-preview`.
4. Edit `dist/tonconnect-manifest.json` BEFORE drag-and-drop:
   - Change all `https://giftsnipr.com` URLs to your new preview URL (e.g. `https://giftsnipr-preview.netlify.app`)
5. Open the preview URL on iPhone Safari

---

## What you should see

**GIFTS tab** (default): Exact same app as `giftsnipr.com` today
- BETA banner at top (dismissible)
- Floor alert
- GiftSnipr brand bar with Snipr eye, BETA pill, and CONNECT button
- Streak card with claim button
- Social proof row
- SNIPES / FLOORS / YOU / WALL tabs
- Snipr-says card
- Leaderboard

**COINS tab**: Placeholder for Turn 3
- Big gold coin
- "TON MEMECOIN SNIPING — COMING IN v0.3"
- Feature list
- "Architecture & DEX integration validated. UI shipping next turn."

Tap the GIFTS / COINS buttons at the very top to toggle.

---

## What's NOT in Turn 2

- Real coins UI (Turn 3)
- DeDust swap flow (Turn 4)
- Honeypot detection (Turn 5)
- Real-data backend (Turn 8)

These all come in subsequent turns. Each turn ends with a previewable build.

---

## File structure

```
giftsnipr-v3/
├── .devcontainer/devcontainer.json     ← Codespaces auto-setup
├── public/
│   ├── _headers                        ← Netlify security headers
│   ├── tonconnect-manifest.json        ← Static manifest (production)
│   ├── icon-192.png, icon-512.png
│   ├── privacy.html, terms.html, snipr.html
├── src/
│   ├── coins/                          ← (Turn 3) COINS UI
│   ├── gifts/
│   │   ├── app.js                      ← Migrated production app (with import refactor)
│   │   └── body.html                   ← Production HTML body (injected at runtime)
│   ├── shared/                         ← (Turn 4+) common helpers
│   ├── styles/
│   │   ├── main.css                    ← Production CSS (unchanged)
│   │   └── v3-toggle.css               ← New: GIFTS/COINS toggle + placeholder
│   ├── ton/                            ← (Turn 4) DeDust SDK wrappers
│   └── main.js                         ← Boot orchestrator
├── index.html                          ← Vite entry shell
├── package.json
├── vite.config.js                      ← Includes dynamic manifest middleware
└── README.md
```

---

## Known npm audit findings (same as Turn 1, still accepted)

8 issues (5 low, 3 moderate). All in dev-time transitive deps. None affect
signed transactions, fee routing, or production user funds. Revisited in Turn 7.

---

## Migration safety verification

The Turn 2 build was verified against the production code:

- **TonConnect**: replaced CDN `window.TON_CONNECT_UI.TonConnectUI` with
  bundled `import { TonConnectUI } from '@tonconnect/ui'`. Same options.
  Same status-change subscription logic. Same `widgetRootId`.
- **Domain verification**: `OFFICIAL_DOMAIN` and `SECURITY.isOfficialDomain()`
  preserved unchanged (4 references in `app.js`).
- **Wallet address validation**: `toFriendlyAddress()` and the strict
  `WALLET.setAddress` setter preserved.
- **No new CDN scripts** in the page (verified with grep).
- **No private keys, seeds, mnemonics** in the bundle (verified with grep,
  except false positives where the words appear in user-facing warnings).
- **Manifest URL** is constructed from `window.location.origin` at runtime
  — so it works on any Codespaces / Netlify preview / production origin.

---

## Quick commands reference

```
npm install         # one time, auto-runs on Codespaces creation
npm run dev         # dev server with live reload (Codespaces preview)
npm run build       # production build → dist/ folder
npm run preview     # serve the production build locally to test
npm run audit       # check security advisories
```

---

## What to report back after Turn 2

After opening in Codespaces + previewing on iPhone:

1. ✅ Gifts tab looks/works the same as `giftsnipr.com` ? 
2. ✅ COINS toggle button works and shows the placeholder ?
3. ✅ Wallet connect still works (try connecting Tonkeeper) ?
4. ✅ Any visual glitches at iPhone size ?

If all green, we proceed to Turn 3 (real COINS UI with GeckoTerminal data).
