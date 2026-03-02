'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots', 'upwork');
const SUBMIT_TIMEOUT = 30000;

const COVER_LETTER_SELECTORS = [
  '[data-test="cover-letter-text"]',
  'textarea.air3-textarea.inner-textarea',
  'textarea.air3-textarea',
  'textarea[placeholder*="cover letter" i]',
  'textarea[name*="cover" i]',
  '#cover-letter',
  '.cover-letter textarea',
  'form textarea:first-of-type',
  'textarea',
];

/**
 * UpworkSubmitter — Playwright form-fill + submit engine for Upwork proposals.
 *
 * Reuses the scanner's existing browser instance (no second browser launch).
 * Supports dry-run mode for safe validation before spending real Connects.
 */
class UpworkSubmitter {
  constructor({ scanner, db, messenger, notificationManager, config }) {
    this._scanner = scanner;
    this._udb = db;
    this._messenger = messenger;
    this._notificationManager = notificationManager;
    this._config = config;
    this._submitting = false;
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  get isDryRun() {
    return this._config.upwork?.dryRun === true || process.env.UPWORK_DRY_RUN === 'true';
  }

  /**
   * Submit a proposal for a job via Playwright form fill.
   *
   * @param {Object} job - Job row from DB (with uid, id, title, url)
   * @param {Object} opts
   * @param {string} opts.coverLetter - Cover letter text
   * @param {string|null} opts.screeningAnswers - Screening Q/A text
   * @param {boolean} [opts.dryRun] - Override dry-run mode
   * @returns {{ success: boolean, dryRun?: boolean, skipped?: boolean, error?: string }}
   */
  async submitJob(job, { coverLetter, screeningAnswers, dryRun }) {
    if (this._submitting) {
      this._log('WARNING: Submission already in progress, skipping');
      return { success: false, skipped: true };
    }

    this._submitting = true;
    const effectiveDryRun = dryRun !== undefined ? !!dryRun : this.isDryRun;

    this._udb.updateJobStatus(job.uid, 'submitting');

    let context;
    let page;
    try {
      context = await this._scanner.getContext();
      page = await context.newPage();

      // Navigate to the job detail page first, then click Apply Now.
      // Direct /apply/ URLs trigger Cloudflare Turnstile CAPTCHA, but navigating
      // from the job page (like a real user) uses internal routing and avoids it.
      const jobUrl = job.url || `https://www.upwork.com/jobs/~${job.uid}`;
      this._log(`Navigating to job page${effectiveDryRun ? ' (DRY-RUN)' : ''}: ${jobUrl}`);

      await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._scanner.waitForCloudflare(page);

      // Verify we're on the job page (not redirected to login)
      let currentUrl = page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('/account-security')) {
        throw new Error('AUTH_EXPIRED: Redirected to login');
      }

      // Wait for job detail page to render, then click Apply Now
      this._log('Waiting for job detail page to load...');

      // Check if job is still available
      await page.waitForTimeout(2000);
      const jobGone = await page.evaluate(() => {
        const body = document.body.textContent || '';
        return body.includes('no longer available') || body.includes('has been removed') ||
               body.includes('job has been closed') || body.includes('Job not found');
      }).catch(() => false);
      if (jobGone) {
        this._udb.updateJobStatus(job.uid, 'expired');
        throw new Error('JOB_EXPIRED: This job is no longer available');
      }

      const applyBtnSel = 'a[href*="/apply"], button:has-text("Apply Now"), [data-test*="apply"] a, a:has-text("Apply Now")';
      try {
        await page.locator(applyBtnSel).first().waitFor({ state: 'visible', timeout: 15000 });
      } catch {
        throw new Error('SELECTOR_MISS: Apply Now button not found on job detail page');
      }

      // Click Apply Now and wait for navigation to the apply form
      this._log('Clicking Apply Now button...');
      await page.locator(applyBtnSel).first().click();
      await page.waitForURL(url => url.includes('/apply') || url.includes('/proposals'), { timeout: 15000 }).catch(() => {});
      await this._scanner.waitForCloudflare(page);
      // Wait for SPA to finish loading after navigation
      await page.waitForLoadState('networkidle').catch(() => {});

      // Wait for SPA to finish rendering the apply form (Vue.js lazy-loads content)
      await this._waitForFormLoad(page);
      await this._checkForCaptcha(page);

      // Verify we're on the apply page
      currentUrl = page.url();
      if (!currentUrl.includes('/apply') && !currentUrl.includes('/proposals')) {
        throw new Error('SUBMIT_BADURL: Unexpected URL after Apply click: ' + currentUrl);
      }

      // In dry-run mode, log all form elements for selector discovery
      if (effectiveDryRun) {
        const formElements = await page.evaluate(() => {
          const textareas = Array.from(document.querySelectorAll('textarea')).map(el => ({
            tag: 'textarea', id: el.id, name: el.name, dataTest: el.getAttribute('data-test'),
            placeholder: el.placeholder, className: el.className.substring(0, 80),
          }));
          const selects = Array.from(document.querySelectorAll('select')).map(el => ({
            tag: 'select', id: el.id, name: el.name, dataTest: el.getAttribute('data-test'),
            options: Array.from(el.options).map(o => o.label || o.textContent).slice(0, 10),
          }));
          const buttons = Array.from(document.querySelectorAll('button[type="submit"], button')).filter(
            el => /submit|send|apply/i.test(el.textContent)
          ).map(el => ({
            tag: 'button', type: el.type, dataTest: el.getAttribute('data-test'),
            text: el.textContent.trim().substring(0, 50),
          }));
          return { textareas, selects, buttons };
        });
        this._log('[DRY-RUN] Form elements discovered:');
        this._log(JSON.stringify(formElements, null, 2));
      }

      // Fill the proposal form
      const clLocator = await this._findCoverLetterTextarea(page);
      await this._fillTextarea(page, clLocator, coverLetter);
      await this._setRateIncrease(page);
      await this._fillScreeningAnswers(page, screeningAnswers);

      const connectsCost = await this._readConnectsCost(page);
      const result = await this._submitAndVerify(page, job, effectiveDryRun);

      // On real submission success, record to DB
      if (result.success && !effectiveDryRun) {
        this._udb.updateJobStatus(job.uid, 'applied');
        this._udb.insertApplication(job.id, coverLetter, screeningAnswers, connectsCost);
        this._log(`Applied to job ${job.uid}${connectsCost ? ' (' + connectsCost + ' connects)' : ''}`);
        await this._scanner.getConnectsBalance(page).catch(() => {});
      }

      return result;
    } catch (error) {
      await this._handleFailure(page, job, error);
      return { success: false, error: error.message };
    } finally {
      this._submitting = false;
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
    }
  }

  async _waitForFormLoad(page) {
    // After Cloudflare/navigation, wait for the apply form SPA to render.
    // Must find actual proposal form content — NOT the nav bar search form.
    const deadline = Date.now() + 25000;
    this._log('Waiting for apply form to render...');

    // First, wait for network to settle
    await page.waitForLoadState('networkidle').catch(() => {});

    while (Date.now() < deadline) {
      const hasApplyForm = await page.evaluate(() => {
        const body = document.body?.textContent || '';
        // Check for proposal-specific content
        if (body.includes('Cover Letter') && document.querySelectorAll('textarea').length > 0) return 'textarea+label';
        if (body.includes('Submit proposal') || body.includes('Send proposal')) return 'submit-btn';
        if (body.includes('Proposal settings') || body.includes('This proposal requires')) return 'proposal-header';
        if (document.querySelector('[data-test="cover-letter-text"]')) return 'data-test';
        if (document.querySelector('[data-test="submit-proposal-btn"]')) return 'data-test-btn';
        return false;
      }).catch(() => false);

      if (hasApplyForm) {
        this._log(`Apply form loaded (detected via: ${hasApplyForm})`);
        await page.waitForTimeout(1000);
        return;
      }
      await page.waitForTimeout(1500);
    }

    this._log('WARNING: Apply form did not render within 25s — continuing with whatever loaded');
  }

  async _findCoverLetterTextarea(page) {
    for (const sel of COVER_LETTER_SELECTORS) {
      const loc = page.locator(sel);
      if (await loc.count() > 0) {
        this._log(`Cover letter textarea found with selector: ${sel}`);
        return loc.first();
      }
    }
    throw new Error('SELECTOR_MISS: Cover letter textarea not found with any known selector');
  }

  async _fillTextarea(page, locator, text) {
    await locator.waitFor({ state: 'visible', timeout: 15000 });

    // Primary fill
    await locator.fill(text);
    const actual = await locator.inputValue();
    if (actual === text) return;

    // Fallback — native setter for Vue.js reactivity
    this._log('Primary fill readback mismatch, using native setter fallback');
    const handle = await locator.elementHandle();
    await page.evaluate((el, val) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, handle, text);

    // Blur to flush Vue queue
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

    const actual2 = await locator.inputValue();
    if (actual2 !== text) {
      throw new Error(`FILL_FAILED: Textarea fill failed: expected ${text.length} chars, got ${actual2.length} chars`);
    }
  }

  async _checkForCaptcha(page) {
    const hasCaptcha = await page.evaluate(() =>
      !!(document.querySelector('iframe[src*="recaptcha"]') ||
         document.querySelector('iframe[src*="hcaptcha"]') ||
         document.querySelector('[class*="captcha"]'))
    );
    if (hasCaptcha) throw new Error('CAPTCHA: Human-solvable challenge detected on apply page');
  }

  async _setRateIncrease(page) {
    // Try native <select> first
    const nativeSel = 'select[name*="rate" i], [data-test*="rate-schedule"] select, [data-test*="rate-increase"] select';
    const nativeCount = await page.locator(nativeSel).count();
    if (nativeCount > 0) {
      try {
        await page.locator(nativeSel).first().selectOption({ label: 'Never' });
        this._log('Rate increase set to "Never" (native select)');
        return;
      } catch {}
    }

    // Upwork uses custom dropdown ("Select a frequency") — look for it and pick "Never"
    try {
      // Find the dropdown trigger - could be button, div, or select-like element
      const freqDropdown = page.locator('text="Select a frequency"').first();
      if (await freqDropdown.isVisible().catch(() => false)) {
        await freqDropdown.click();
        await page.waitForTimeout(800);
        // Click "Never" option — try multiple selector strategies
        const neverOption = page.locator('[role="option"]:has-text("Never"), [role="listbox"] li:has-text("Never"), li:text("Never"), div[class*="option"]:has-text("Never"), text="Never"');
        const neverCount = await neverOption.count();
        if (neverCount > 0) {
          // Click the last match (likely the dropdown item, not any other "Never" text on page)
          await neverOption.nth(neverCount > 1 ? neverCount - 1 : 0).click();
          this._log('Rate increase set to "Never" (custom dropdown)');
          await page.waitForTimeout(300);
          return;
        }
      }
    } catch {}

    this._log('Rate increase dropdown not found or could not be set (may be fixed-price or pre-set)');
  }

  async _fillScreeningAnswers(page, screeningAnswers) {
    if (!screeningAnswers) return;

    // Parse Q/A blocks (format: "Q: question\nA: answer")
    const qaBlocks = screeningAnswers.split(/\nQ:/i).filter(Boolean);

    const questionSelectors = '[data-test*="question"] textarea, .additional-questions textarea, [class*="screening"] textarea';
    let questionTextareas = page.locator(questionSelectors);
    let count = await questionTextareas.count();

    // Fallback: find all textareas except the cover letter
    if (count === 0) {
      const allTextareas = page.locator('textarea');
      const totalTextareas = await allTextareas.count();
      if (totalTextareas > 1) {
        // Skip first textarea (cover letter), use the rest
        count = totalTextareas - 1;
        questionTextareas = allTextareas;
        this._log(`Using fallback screening textarea detection (${count} extra textareas)`);
      } else {
        this._log('No screening question textareas found');
        return;
      }
    }

    const startIdx = count < await page.locator('textarea').count() ? 0 : 0;
    const maxFill = Math.min(count, qaBlocks.length);

    for (let i = 0; i < maxFill; i++) {
      const answerMatch = qaBlocks[i].match(/\nA:\s*([\s\S]+)/i);
      if (!answerMatch) continue;

      const answer = answerMatch[1].trim();
      try {
        await this._fillTextarea(page, questionTextareas.nth(i + startIdx), answer);
        this._log(`Screening answer ${i + 1}/${maxFill} filled`);
      } catch (e) {
        this._log(`WARNING: Screening answer ${i + 1} fill failed: ${e.message.substring(0, 80)}`);
      }
    }
  }

  async _readConnectsCost(page) {
    return page.evaluate(() => {
      const candidates = document.querySelectorAll('[data-test*="connects"], [class*="connects"], [class*="Connects"]');
      for (const el of candidates) {
        const match = el.textContent.match(/(\d+)\s*Connects?/i);
        if (match) return parseInt(match[1], 10);
      }
      const formArea = document.querySelector('form') || document.body;
      const match = formArea.textContent.match(/(\d+)\s*Connects?/i);
      return match ? parseInt(match[1], 10) : null;
    });
  }

  async _submitAndVerify(page, job, isDryRun) {
    const submitSel = '[data-test="submit-proposal-btn"], button:has-text("Send for"), button:has-text("Submit proposal"), button:has-text("Submit Proposal"), button:has-text("Send Proposal")';
    const submitBtn = page.locator(submitSel).first();
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    await submitBtn.waitFor({ state: 'visible', timeout: 15000 });

    if (isDryRun) {
      const btnText = await submitBtn.textContent().catch(() => '(unknown)');
      this._log('[DRY-RUN] Submit button found: ' + btnText.trim());
      this._log('[DRY-RUN] Current URL: ' + page.url());
      // Read back cover letter using the actual textarea selector chain
      let clLength = 0;
      for (const sel of COVER_LETTER_SELECTORS) {
        const loc = page.locator(sel);
        if (await loc.count() > 0) {
          clLength = await loc.first().inputValue().then(v => v.length).catch(() => 0);
          break;
        }
      }
      this._log('[DRY-RUN] Cover letter filled: ' + clLength + ' chars');
      this._log('[DRY-RUN] SUCCESS — form ready for real submission');
      return { success: true, dryRun: true };
    }

    // Real submission
    await submitBtn.click();

    let confirmed = false;
    try {
      await page.waitForURL(
        url => url.includes('?success') || url.includes('/submitted') || !url.includes('/apply/'),
        { timeout: SUBMIT_TIMEOUT }
      );
      confirmed = true;
    } catch {}

    if (!confirmed) {
      const successSel = '[data-test="proposal-submitted"], [class*="success"], h1:has-text("Proposal"), h2:has-text("submitted")';
      confirmed = (await page.locator(successSel).count()) > 0;
    }

    if (!confirmed) {
      throw new Error('SUBMIT_UNCONFIRMED: No success signal detected after submit click');
    }

    this._log('Submission confirmed for job ' + job.uid + ' (URL: ' + page.url() + ')');
    return { success: true, dryRun: false };
  }

  async _handleFailure(page, job, error) {
    // Screenshot
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(SCREENSHOT_DIR, `failure-${job.uid}-${timestamp}.png`);
    if (page) {
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5000 });
        this._log('Screenshot saved: ' + screenshotPath);
      } catch (screenshotErr) {
        this._log('WARNING: Screenshot failed: ' + screenshotErr.message);
      }
    }

    // Classify error type
    const msg = error.message || String(error);
    let errorType;
    if (msg.includes('AUTH_EXPIRED')) errorType = 'AUTH_EXPIRED';
    else if (msg.includes('JOB_EXPIRED')) errorType = 'JOB_EXPIRED';
    else if (msg.includes('CAPTCHA')) errorType = 'CAPTCHA';
    else if (msg.includes('timeout') || msg.includes('TimeoutError')) errorType = 'TIMEOUT';
    else if (msg.includes('SUBMIT_UNCONFIRMED')) errorType = 'SUBMIT_UNCONFIRMED';
    else if (msg.includes('SELECTOR_MISS')) errorType = 'SELECTOR_MISS';
    else if (msg.includes('FILL_FAILED')) errorType = 'FILL_FAILED';
    else if (msg.includes('SUBMIT_BADURL')) errorType = 'SUBMIT_BADURL';
    else errorType = msg.substring(0, 80);

    // Log failure — no SMS for routine submission errors (Cloudflare, selectors, timeouts)
    // Only alert for AUTH_EXPIRED which requires manual intervention
    this._log(`SUBMIT FAILED [${errorType}] ${job.title.substring(0, 40)} (${job.uid})`);
    if (errorType === 'AUTH_EXPIRED' && this._notificationManager) {
      this._notificationManager.notify(`Upwork auth expired — re-login needed`, 2);
    }

    // Update job status
    this._udb.updateJobStatus(job.uid, 'submit_failed', msg.substring(0, 200));
  }

  _log(msg) { console.log('[UPWORK-SUBMIT] ' + msg); }
}

module.exports = UpworkSubmitter;
