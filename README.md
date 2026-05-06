# UFMC1 Worker

Playwright-based worker that runs **outside Lovable** (VPS, Railway, Render, etc.) because Cloudflare Workers cannot run a real browser.

## What it does

1. Polls `POST /api/public/worker/poll` on your Lovable site for a queued job.
2. Decrypted student credentials are returned in the response.
3. Logs into `apps.umc.edu.dz` via Google OAuth (with stealth plugin).
4. Cancels existing confirmed choices, then picks the new ones in order, then clicks `CONFIRMER`.
5. Posts back to `POST /api/public/worker/result` with status `done` / `failed` / `needs_manual` and updated session cookies.
6. The Lovable site notifies the student on Telegram automatically.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `WORKER_API_TOKEN` | yes | Must match the secret set in Lovable |
| `API_BASE` | optional | Defaults to `https://uniluca.lovable.app` |
| `WORKER_ID` | optional | Identifier shown in `jobs.locked_by` |
| `POLL_INTERVAL_MS` | optional | Default 10000 |
| `SCREENSHOT_DIR` | optional | Default `./screenshots` |

## Deploy on Railway (easiest, free tier works)

```bash
# 1. Push this `worker/` folder to a GitHub repo
# 2. railway.app → New Project → Deploy from repo → pick this folder
# 3. Add env var WORKER_API_TOKEN (same value you set in Lovable secrets)
# 4. Build command: npm install && npx playwright install --with-deps chromium
# 5. Start command: node index.js
```

## Deploy on a VPS

```bash
git clone <your repo>
cd worker
npm install
npx playwright install --with-deps chromium
WORKER_API_TOKEN=xxx node index.js
# Or use pm2 / systemd to keep it alive
```

## Important notes

- **Google blocks automated logins aggressively.** The first login per student usually triggers a phone-verification or "Try again later" page. Do the **first** login manually in a real browser, export cookies, then store them via the database — afterwards the worker can reuse `session_cookies` and skip Google entirely.
- **Selectors are best-effort.** The DOM of `apps.umc.edu.dz` was inferred from the screenshots provided. After the first real run, look at the saved screenshots in `./screenshots/` and tighten the selectors in `index.js` (functions `gotoOrientations`, `cancelExistingChoices`, `pickChoices`, `confirm`).
- **Captchas:** Google reCAPTCHA cannot be reliably auto-solved. If encountered, the worker reports `needs_manual` and the admin must intervene.
- Run **one worker at a time** to avoid double-processing the same job (the API claims jobs atomically but extra workers waste resources).
- 
