// UFMC1 Playwright Worker
// Polls the Lovable API for queued jobs and automates apps.umc.edu.dz

import { chromium as base } from "playwright";
import { chromium as extraChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import path from "path";

extraChromium.use(StealthPlugin());

const API_BASE = process.env.API_BASE || "https://uniluca.lovable.app";
const TOKEN = process.env.WORKER_API_TOKEN;
const WORKER_ID = process.env.WORKER_ID || "worker-1";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10_000);
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || "./screenshots";

if (!TOKEN) {
  console.error("WORKER_API_TOKEN env var is required");
  process.exit(1);
}
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function api(method, body) {
  const res = await fetch(`${API_BASE}/api/public/worker/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`${method} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function shot(page, jobId, label) {
  const file = path.join(SCREENSHOT_DIR, `${jobId}-${Date.now()}-${label}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
  } catch {}
  return file;
}

async function loginGoogle(page, job) {
  const { email, password } = job.student;
  await page.goto("https://apps.umc.edu.dz/authentification/", {
    waitUntil: "domcontentloaded",
  });
  await shot(page, job.id, "01-auth");

  // Click "Compte UFMC1" → Google OAuth
  const btn = page.locator("text=/UFMC1|Google/i").first();
  await btn.click({ timeout: 10_000 });

  // Email
  await page.waitForSelector('input[type="email"]', { timeout: 20_000 });
  await page.fill('input[type="email"]', email);
  await page.click("#identifierNext");

  // Password
  await page.waitForSelector('input[type="password"]', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.fill('input[type="password"]', password);
  await page.click("#passwordNext");

  // Wait for redirect back to apps.umc.edu.dz
  try {
    await page.waitForURL(/apps\.umc\.edu\.dz/, { timeout: 30_000 });
  } catch (e) {
    // Likely a Google challenge (phone, captcha, 2FA)
    await shot(page, job.id, "99-google-challenge");
    throw new Error("needs_manual: Google challenge encountered");
  }
  await shot(page, job.id, "02-after-login");
}

async function gotoOrientations(page, job) {
  // Navigate to "Espace étudiants" → "Orientations"
  // The exact selectors must be confirmed using user-provided screenshots.
  await page.goto("https://apps.umc.edu.dz/orientation/", {
    waitUntil: "domcontentloaded",
  });
  await shot(page, job.id, "03-orientations");
}

async function cancelExistingChoices(page, job) {
  // If a "CONFIRMER" was already done, choices need to be cancelled first.
  // Look for "Annuler" / cancellation buttons next to each row.
  const cancels = page.locator('button:has-text("Annuler"), a:has-text("Annuler")');
  const n = await cancels.count();
  for (let i = 0; i < n; i++) {
    try {
      await cancels.nth(0).click({ timeout: 5_000 });
      await page.waitForTimeout(800);
    } catch {}
  }
  await shot(page, job.id, "04-after-cancel");
}

async function pickChoices(page, job) {
  // For each major in job.choices (in order), click its "Choisir" / row.
  // Since real selectors come from the live site, this is intentionally
  // tolerant: it tries by visible text match.
  for (const [i, m] of job.choices.entries()) {
    const row = page.locator(`text=${m.name}`).first();
    await row.scrollIntoViewIfNeeded().catch(() => {});
    // Click the closest action button
    const action = row
      .locator("xpath=ancestor::tr//button | xpath=ancestor::*[self::div or self::li][1]//button")
      .first();
    try {
      await action.click({ timeout: 5_000 });
    } catch {
      await row.click({ timeout: 5_000 }).catch(() => {});
    }
    await page.waitForTimeout(600);
    await shot(page, job.id, `05-pick-${i + 1}`);
  }
}

async function confirm(page, job) {
  const confirm = page.locator('button:has-text("CONFIRMER"), a:has-text("CONFIRMER")').first();
  await confirm.click({ timeout: 10_000 });
  // Possible JS confirm dialog
  page.once("dialog", (d) => d.accept().catch(() => {}));
  await page.waitForTimeout(2_000);
  await shot(page, job.id, "06-confirmed");
}

async function runJob(job) {
  const browser = await extraChromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    storageState: job.student.session_cookies || undefined,
    locale: "fr-FR",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();
  let result;
  let session_cookies;
  try {
    // Try existing session first
    await page.goto("https://apps.umc.edu.dz/orientation/", {
      waitUntil: "domcontentloaded",
    });
    if (!/apps\.umc\.edu\.dz/.test(page.url()) || /authentification/.test(page.url())) {
      await loginGoogle(page, job);
    }
    await gotoOrientations(page, job);
    await cancelExistingChoices(page, job);
    await pickChoices(page, job);
    await confirm(page, job);
    session_cookies = await context.storageState();
    result = { ok: true };
    await api("result", {
      job_id: job.id,
      status: "done",
      result,
      session_cookies,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const needsManual = msg.startsWith("needs_manual");
    await api("result", {
      job_id: job.id,
      status: needsManual ? "needs_manual" : "failed",
      error: msg,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function loop() {
  console.log(`[worker] ${WORKER_ID} polling ${API_BASE}`);
  while (true) {
    try {
      const { job } = await api("poll", { worker_id: WORKER_ID });
      if (job) {
        console.log(`[worker] running job ${job.id} type=${job.type}`);
        await runJob(job);
      } else {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (e) {
      console.error("[worker] error:", e.message);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

loop();
