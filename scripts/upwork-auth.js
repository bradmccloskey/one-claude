#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const AUTH_STATE_PATH = path.join(__dirname, '..', '.upwork-auth.json');

// Use a temp profile seeded from the real Chrome profile's cookies
const REAL_CHROME_PROFILE = path.join(
  process.env.HOME, 'Library/Application Support/Google/Chrome/Default'
);

async function main() {
  console.log('Launching your real Chrome for Upwork login...');
  console.log('This uses channel:"chrome" to avoid Google bot detection.\n');

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',  // Use real Chrome, not Chromium for Testing
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  await page.goto('https://www.upwork.com/ab/account-security/login', {
    waitUntil: 'domcontentloaded',
  });

  console.log('Log in via Google (or however you normally do).');
  console.log('Waiting up to 10 minutes...\n');

  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const url = page.url();
      const isLoginPage = url.includes('/login') ||
                          url.includes('/account-security') ||
                          url.includes('accounts.google.com');
      if (!isLoginPage && url.includes('upwork.com')) {
        console.log(`Logged in! URL: ${url}`);
        break;
      }
    } catch {}
  }

  if (Date.now() >= deadline) {
    console.error('Timeout.');
    await browser.close();
    process.exit(1);
  }

  await new Promise(r => setTimeout(r, 3000));
  await context.storageState({ path: AUTH_STATE_PATH });
  console.log(`Session saved to ${AUTH_STATE_PATH}`);
  await browser.close();
  console.log('Done! Scanner will use this session.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
