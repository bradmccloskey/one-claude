'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots', 'upwork');
const SUBMIT_TIMEOUT = 30000;

const COVER_LETTER_SELECTORS = [
  '[data-test="cover-letter-text"]',
  'textarea[placeholder*="cover letter" i]',
  'textarea[name*="cover" i]',
  '#cover-letter',
  '.cover-letter textarea',
  'form textarea:first-of-type',
];

/**
 * UpworkSubmitter — Playwright form-fill + submit engine for Upwork proposals.
 *
 * Reuses the scanner's existing browser instance (no second browser launch).
 * Supports dry-run mode for safe validation before spending real Connects.
 */
class UpworkSubmitter {
  constructor({ scanner, db, messenger, config }) {
    this._scanner = scanner;
    this._udb = db;
    this._messenger = messenger;
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

      const applyUrl = `https://www.upwork.com/ab/proposals/job/~${job.uid}/apply/`;
      this._log(`Navigating to ${applyUrl}${effectiveDryRun ? ' (DRY-RUN)' : ''}`);

      await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._scanner.waitForCloudflare(page);
      await this._checkForCaptcha(page);

      // Verify we're on the apply page
      const currentUrl = page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('/account-security')) {
        throw new Error('AUTH_EXPIRED: Redirected to login');
      }
      if (!currentUrl.includes('/apply') && !currentUrl.includes('/proposals')) {
        throw new Error('SUBMIT_BADURL: Unexpected URL: ' + currentUrl);
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
    const selectors = 'select[name*="rate" i], [data-test*="rate-schedule"] select, [data-test*="rate-increase"] select';
    const count = await page.locator(selectors).count();
    if (count === 0) {
      this._log('Rate increase dropdown not found (may be fixed-price job or pre-set in profile)');
      return;
    }
    try {
      await page.locator(selectors).first().selectOption({ label: 'Never' });
      this._log('Rate increase set to "Never"');
    } catch {
      try {
        await page.locator(selectors).first().selectOption('0');
        this._log('Rate increase set to "0" (fallback)');
      } catch {
        this._log('WARNING: Rate increase dropdown could not be set to Never');
      }
    }
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
    const submitSel = '[data-test="submit-proposal-btn"], button[type="submit"]:has-text("Send"), button:has-text("Submit Proposal"), button:has-text("Send Proposal")';
    const submitBtn = page.locator(submitSel).first();
    await submitBtn.waitFor({ state: 'visible', timeout: 10000 });

    if (isDryRun) {
      this._log('[DRY-RUN] Submit button found: ' + await submitBtn.textContent());
      this._log('[DRY-RUN] Current URL: ' + page.url());
      const clLength = await page.locator(COVER_LETTER_SELECTORS[0] + ', form textarea:first-of-type').first().inputValue().then(v => v.length).catch(() => 0);
      this._log('[DRY-RUN] Cover letter filled: ' + clLength + ' chars');
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
    else if (msg.includes('CAPTCHA')) errorType = 'CAPTCHA';
    else if (msg.includes('timeout') || msg.includes('TimeoutError')) errorType = 'TIMEOUT';
    else if (msg.includes('SUBMIT_UNCONFIRMED')) errorType = 'SUBMIT_UNCONFIRMED';
    else if (msg.includes('SELECTOR_MISS')) errorType = 'SELECTOR_MISS';
    else if (msg.includes('FILL_FAILED')) errorType = 'FILL_FAILED';
    else if (msg.includes('SUBMIT_BADURL')) errorType = 'SUBMIT_BADURL';
    else errorType = msg.substring(0, 80);

    // SMS alert
    const smsMsg = `UPWORK SUBMIT FAILED\nType: ${errorType}\nJob: ${job.title.substring(0, 40)}\nUID: ${job.uid}`;
    try {
      this._messenger.send(smsMsg);
    } catch (smsErr) {
      this._log('WARNING: SMS send failed: ' + smsErr.message);
    }

    // Update job status
    this._udb.updateJobStatus(job.uid, 'submit_failed', msg.substring(0, 200));
  }

  _log(msg) { console.log('[UPWORK-SUBMIT] ' + msg); }
}

module.exports = UpworkSubmitter;
