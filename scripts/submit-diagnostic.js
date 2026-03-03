'use strict';
const { chromium } = require('playwright');
const path = require('path');
const AUTH_FILE = path.join(__dirname, '..', '.upwork-auth.json');

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--window-position=-9999,-9999']
  });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();

  console.log('Navigating to job page...');
  await page.goto('https://www.upwork.com/jobs/OpenClaw-Programming-for-Shopify_~022028592119381443121/', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });

  // Handle Cloudflare
  for (let i = 0; i < 10; i++) {
    const title = await page.title();
    if (/challenge|just a moment|attention/i.test(title)) {
      console.log('Cloudflare challenge detected, waiting...');
      await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
    } else {
      break;
    }
  }
  await page.waitForTimeout(5000);

  console.log('URL:', page.url());
  console.log('Title:', await page.title());

  // Get page text
  const text = await page.evaluate(() => document.body.innerText.substring(0, 1500));
  console.log('\nPage text:\n', text);

  // Find all buttons and links
  const elements = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    return btns.filter(b => /apply|submit|send/i.test(b.textContent) && b.textContent.length < 100)
      .map(b => ({
        tag: b.tagName,
        text: b.textContent.trim().substring(0, 60),
        href: b.href || '',
        visible: b.offsetParent !== null,
        disabled: b.disabled,
      }));
  });
  console.log('\nApply/Submit elements:', JSON.stringify(elements, null, 2));

  // Try direct apply URL
  if (!page.url().includes('/apply')) {
    console.log('\nTrying direct apply URL...');
    await page.goto('https://www.upwork.com/nx/proposals/job/~022028592119381443121/apply/', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });

    for (let i = 0; i < 10; i++) {
      const title = await page.title();
      if (/challenge|just a moment|attention/i.test(title)) {
        console.log('Cloudflare on apply page, waiting...');
        await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
      } else {
        break;
      }
    }
    await page.waitForTimeout(5000);

    console.log('Apply URL:', page.url());
    console.log('Apply Title:', await page.title());

    const applyText = await page.evaluate(() => document.body.innerText.substring(0, 800));
    console.log('\nApply page text:\n', applyText);

    await page.screenshot({ path: '/tmp/upwork-apply-diagnostic.png', fullPage: true });
    console.log('\nScreenshot saved');
  }

  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
