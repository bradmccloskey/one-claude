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
      await this._setProjectDuration(page);
      await this._fillMilestones(page, job);
      await this._fillScreeningAnswers(page, screeningAnswers);
      await this._fillEmptyRequiredTextareas(page, job);

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
    await handle.evaluate((el, val) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);

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

    // Upwork uses a native <select> inside the "Schedule a rate increase" section
    // Look for any <select> near "rate increase" or "frequency" text
    try {
      const allSelects = page.locator('select');
      const selectCount = await allSelects.count();
      for (let i = 0; i < selectCount; i++) {
        const optTexts = await allSelects.nth(i).evaluate(el =>
          Array.from(el.options).map(o => o.textContent.trim().toLowerCase())
        ).catch(() => []);
        // This is the rate increase frequency select if it has "never" as an option
        if (optTexts.some(t => t === 'never')) {
          const options = await allSelects.nth(i).evaluate(el =>
            Array.from(el.options).map(o => ({ value: o.value, text: o.textContent.trim() }))
          );
          const neverOpt = options.find(o => o.text.toLowerCase() === 'never');
          if (neverOpt) {
            await allSelects.nth(i).selectOption(neverOpt.value);
            this._log('Rate increase set to "Never" (via select option scan)');
            await page.waitForTimeout(500);
            return;
          }
        }
      }
    } catch (e) {
      this._log('Rate increase select scan error: ' + e.message.substring(0, 60));
    }

    // Fallback: Upwork custom dropdown ("Select a frequency") — click to open, pick "Never"
    try {
      const freqDropdown = page.locator('text="Select a frequency"').first();
      if (await freqDropdown.isVisible().catch(() => false)) {
        await freqDropdown.click();
        await page.waitForTimeout(1000);
        // Try clicking "Never" via multiple strategies
        const strategies = [
          page.locator('option:has-text("Never")'),
          page.locator('[role="option"]:has-text("Never")'),
          page.locator('[role="listbox"] li:has-text("Never")'),
          page.locator('li:text-is("Never")'),
          page.locator('div[class*="option"]:has-text("Never")'),
        ];
        for (const loc of strategies) {
          if (await loc.count() > 0) {
            await loc.first().click();
            this._log('Rate increase set to "Never" (custom dropdown click)');
            await page.waitForTimeout(500);
            return;
          }
        }
        // If dropdown opened but couldn't find Never, press Escape to close it
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    } catch {}

    this._log('Rate increase dropdown not found or could not be set (may be fixed-price or pre-set)');
  }

  async _setProjectDuration(page) {
    // "How long will this project take?" dropdown — required on fixed-price jobs.
    // Upwork uses a custom air3-dropdown Vue.js component (NOT native <select>).
    try {
      const hasDuration = await page.evaluate(() =>
        document.body.textContent.includes('How long will this project take')
      ).catch(() => false);
      if (!hasDuration) {
        this._log('Project duration field not present (hourly job)');
        return;
      }

      // Strategy 1: Native <select> (unlikely on modern Upwork, but check)
      const nativeSel = 'select[data-test*="duration"], select[name*="duration"]';
      if (await page.locator(nativeSel).count() > 0) {
        const sel = page.locator(nativeSel).first();
        const options = await sel.evaluate(el => Array.from(el.options).map(o => ({ value: o.value, text: o.textContent.trim() })));
        const good = options.find(o => /1\s*to\s*3\s*month/i.test(o.text))
          || options.find(o => o.value && o.value !== '' && !/select/i.test(o.text));
        if (good) {
          await sel.selectOption(good.value);
          this._log('Project duration set to: ' + good.text + ' (native select)');
          return;
        }
      }

      // Strategy 2: Upwork air3-dropdown — DOM interaction via page.evaluate()
      // Find the duration section, click the trigger, then click an option.
      // The entire interaction is done in JS to avoid Playwright selector issues.
      const result = await page.evaluate(() => {
        // Find the "How long will this project take?" section
        const allLabels = document.querySelectorAll('label, h3, h4, h5, div, span, p');
        let durationSection = null;
        for (const el of allLabels) {
          if (el.textContent.includes('How long will this project take')) {
            // Walk up to find the containing form group
            durationSection = el.closest('[class*="form-group"]')
              || el.closest('[class*="field"]')
              || el.closest('section')
              || el.parentElement?.parentElement
              || el.parentElement;
            break;
          }
        }
        if (!durationSection) return { error: 'duration_section_not_found' };

        // Find the dropdown trigger within this section
        // Upwork dropdowns typically have a button/div with aria-haspopup or class containing "dropdown"
        const triggerCandidates = durationSection.querySelectorAll(
          'button, [role="combobox"], [role="listbox"], [aria-haspopup], [class*="dropdown"], [class*="select"]'
        );
        let trigger = null;
        for (const el of triggerCandidates) {
          if (el.textContent.includes('Select a duration') || el.textContent.includes('duration')) {
            trigger = el;
            break;
          }
        }
        // Fallback: any element with "Select a duration" text
        if (!trigger) {
          const all = durationSection.querySelectorAll('*');
          for (const el of all) {
            if (el.childNodes.length <= 3 && el.textContent.trim() === 'Select a duration') {
              trigger = el;
              break;
            }
          }
        }
        if (!trigger) return { error: 'trigger_not_found', html: durationSection.innerHTML.substring(0, 500) };

        // Return the trigger info for Playwright to click
        return {
          triggerTag: trigger.tagName,
          triggerClass: trigger.className?.toString().substring(0, 100),
          triggerText: trigger.textContent.trim().substring(0, 50),
          sectionHTML: durationSection.innerHTML.substring(0, 300),
        };
      });

      this._log('Duration section analysis: ' + JSON.stringify(result));

      if (result.error) {
        this._log('Duration dropdown: ' + result.error);
        return;
      }

      // Now use Playwright to click the trigger and interact with the dropdown
      // Find the trigger element that contains exactly "Select a duration"
      // Click the parent container of the text to ensure the dropdown component receives the event
      const durationContainer = page.locator(':has-text("How long will this project take")').last();

      // Within the duration area, find and click the dropdown trigger
      // Use multiple strategies to locate the clickable element
      const triggerStrategies = [
        page.locator('button:near(:text("How long will this project take"))').first(),
        page.locator('[aria-haspopup]:near(:text("How long will this project take"))').first(),
        page.locator('[class*="dropdown"]:near(:text("How long will this project take"))').first(),
      ];

      let triggerClicked = false;

      // First try: click "Select a duration" text element directly
      const selectDurationText = page.locator('text="Select a duration"').first();
      if (await selectDurationText.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Click the element — try both the text and its parent (the actual dropdown component)
        await selectDurationText.click();
        await page.waitForTimeout(1000);
        triggerClicked = true;

        // Check if dropdown opened by looking for new visible options
        let optionsFound = await page.evaluate(() => {
          const listboxes = document.querySelectorAll('[role="listbox"], ul[class*="dropdown"], ul[class*="menu"], [class*="dropdown-menu"]');
          for (const lb of listboxes) {
            if (lb.offsetParent !== null && lb.querySelectorAll('li, [role="option"]').length > 0) {
              return Array.from(lb.querySelectorAll('li, [role="option"]')).map(li => li.textContent.trim()).filter(t => t.length > 0 && t.length < 50);
            }
          }
          return null;
        }).catch(() => null);

        if (!optionsFound || optionsFound.length === 0) {
          // Dropdown didn't open — try clicking the parent element instead
          this._log('Direct text click did not open dropdown — trying parent click...');
          const parentClick = await page.evaluate(() => {
            const els = document.querySelectorAll('*');
            for (const el of els) {
              if (el.childNodes.length <= 3 && el.textContent.trim() === 'Select a duration') {
                // Click progressively higher parents
                let parent = el.parentElement;
                for (let i = 0; i < 3 && parent; i++) {
                  parent.click();
                  parent = parent.parentElement;
                }
                return true;
              }
            }
            return false;
          });
          await page.waitForTimeout(1500);

          // Re-check for options
          optionsFound = await page.evaluate(() => {
            // Broad search: find any visible list-like elements with duration text
            const allLists = document.querySelectorAll('ul, ol, [role="listbox"], [role="menu"]');
            for (const list of allLists) {
              if (list.offsetParent === null) continue;
              const items = list.querySelectorAll('li, [role="option"]');
              const texts = Array.from(items).map(i => i.textContent.trim()).filter(t => t.length > 0 && t.length < 60);
              if (texts.some(t => /month|week/i.test(t))) return texts;
            }
            // Also check for standalone option divs
            const optDivs = document.querySelectorAll('[class*="option"], [class*="menu-item"]');
            const visibleOpts = Array.from(optDivs)
              .filter(d => d.offsetParent !== null && /month|week/i.test(d.textContent))
              .map(d => d.textContent.trim());
            return visibleOpts.length > 0 ? visibleOpts : null;
          }).catch(() => null);
        }

        if (optionsFound && optionsFound.length > 0) {
          this._log('Duration options found: ' + optionsFound.join(', '));

          // Click the best option — prefer "1 to 3 months" or "Less than a month"
          const clicked = await page.evaluate((options) => {
            const preferred = ['1 to 3 months', 'Less than a month', '3 to 6 months'];
            // Find visible elements matching duration options
            const allEls = document.querySelectorAll('li, [role="option"], [class*="option"], [class*="menu-item"]');
            for (const pref of preferred) {
              for (const el of allEls) {
                if (el.offsetParent !== null && el.textContent.trim() === pref) {
                  el.click();
                  return pref;
                }
              }
            }
            // Fallback: click any option with "month" in it
            for (const el of allEls) {
              if (el.offsetParent !== null && /month/i.test(el.textContent) && el.textContent.trim().length < 30) {
                el.click();
                return el.textContent.trim();
              }
            }
            return null;
          }, optionsFound);

          if (clicked) {
            this._log('Project duration set to: ' + clicked);
            await page.waitForTimeout(500);
            return;
          }
        }
      }

      // Strategy 3: Keyboard-only approach
      // Tab to the duration field and use arrow keys
      this._log('Trying keyboard approach for duration dropdown...');

      // Click the "Select a duration" area to focus it
      if (!triggerClicked) {
        const trigger = page.locator('text="Select a duration"').first();
        if (await trigger.isVisible({ timeout: 2000 }).catch(() => false)) {
          await trigger.click();
          await page.waitForTimeout(500);
        }
      }

      // Try Space (opens many custom dropdowns), then ArrowDown + Enter
      await page.keyboard.press('Space');
      await page.waitForTimeout(800);
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);

      // Verify: check if "Select a duration" text is still visible (meaning nothing changed)
      const stillDefault = await page.evaluate(() => {
        const els = document.querySelectorAll('*');
        for (const el of els) {
          if (el.childNodes.length <= 3 && el.textContent.trim() === 'Select a duration' && el.offsetParent !== null) {
            return true;
          }
        }
        return false;
      }).catch(() => true);

      if (!stillDefault) {
        this._log('Project duration set via keyboard');
        return;
      }

      // Strategy 4: Force-set via Vue.js __vue__ internals
      const vueSet = await page.evaluate(() => {
        // Find the dropdown component instance
        const els = document.querySelectorAll('*');
        for (const el of els) {
          const vue = el.__vue__ || el.__vue_app__ || el._vnode;
          if (!vue) continue;
          // Check if this is a duration-related component
          const text = el.textContent || '';
          if (!text.includes('Select a duration') && !text.includes('How long')) continue;

          // Try to find the select/dropdown component
          if (el.__vue__) {
            const vm = el.__vue__;
            // Air3 dropdown components store value in modelValue or value prop
            if (typeof vm.modelValue !== 'undefined' || typeof vm.value !== 'undefined') {
              // Try setting the value to a known duration option
              if (vm.$emit) {
                vm.$emit('update:modelValue', '1_3_months');
                vm.$emit('change', '1_3_months');
                return 'vue_emit';
              }
            }
          }
        }
        return null;
      }).catch(() => null);

      if (vueSet) {
        this._log('Project duration set via Vue internals: ' + vueSet);
        await page.waitForTimeout(500);
        return;
      }

      this._log('WARNING: Could not set project duration — may cause validation error');
    } catch (e) {
      this._log('Project duration set failed: ' + e.message.substring(0, 80));
    }
  }

  async _fillMilestones(page, job) {
    // Fixed-price jobs require at least one milestone (description + amount).
    // Check if milestone fields exist on the form.
    try {
      const hasPaymentSection = await page.evaluate(() =>
        document.body.textContent.includes('How do you want to be paid?') ||
        document.body.textContent.includes('milestones do you want')
      ).catch(() => false);

      if (!hasPaymentSection) return; // Hourly job, no milestones needed

      // Find milestone description input
      const descInput = page.locator('input[placeholder*="description" i], input[placeholder*="milestone" i], table input[type="text"], [class*="milestone"] input[type="text"]').first();
      const descExists = await descInput.count() > 0;

      if (!descExists) {
        this._log('Milestone fields not found (may not be required)');
        return;
      }

      const descVal = await descInput.inputValue().catch(() => '');
      if (descVal.trim()) {
        this._log('Milestone description already filled');
        return;
      }

      // Fill milestone description
      await descInput.fill('Complete project delivery');
      this._log('Milestone description filled');

      // Fill milestone amount — use the job budget, minimum $5
      const budget = job.budget || 50;
      const amount = Math.max(budget, 5);
      const amountInput = page.locator('input[placeholder*="amount" i], input[placeholder*="$"], table input[type="number"], [class*="milestone"] input[type="number"], input[inputmode="decimal"]').first();
      if (await amountInput.count() > 0) {
        await amountInput.fill(String(amount));
        this._log('Milestone amount filled: $' + amount);
      } else {
        // Try finding amount input near the description
        const allInputs = page.locator('table input, [class*="milestone"] input');
        const inputCount = await allInputs.count();
        for (let i = 0; i < inputCount; i++) {
          const val = await allInputs.nth(i).inputValue().catch(() => '');
          const placeholder = await allInputs.nth(i).getAttribute('placeholder').catch(() => '');
          if (val === '' || val === '$0.00' || val === '0') {
            await allInputs.nth(i).fill(String(amount));
            this._log('Milestone amount filled (fallback): $' + amount);
            break;
          }
        }
      }

      await page.waitForTimeout(500);
    } catch (e) {
      this._log('Milestone fill warning: ' + e.message.substring(0, 60));
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

  async _fillEmptyRequiredTextareas(page, job) {
    // After filling the cover letter and screening answers, check for any remaining
    // empty textareas that might be required (e.g., "Describe your recent experience").
    // These are screening questions not detected during the job detail scrape.
    try {
      const allTextareas = page.locator('textarea');
      const count = await allTextareas.count();
      if (count <= 1) return; // Only cover letter, no screening Qs

      for (let i = 0; i < count; i++) {
        const ta = allTextareas.nth(i);
        const val = await ta.inputValue().catch(() => '');
        if (val.trim()) continue; // Already filled

        // Check if this textarea has a label/question near it
        const info = await ta.evaluate(el => {
          // Walk up to find a label or question text
          let parent = el.parentElement;
          let questionText = '';
          for (let depth = 0; depth < 5 && parent; depth++) {
            const labels = parent.querySelectorAll('label, h3, h4, [class*="question"]');
            for (const l of labels) {
              if (l.textContent.trim() && !l.textContent.includes('Cover Letter')) {
                questionText = l.textContent.trim().substring(0, 200);
                break;
              }
            }
            if (questionText) break;
            parent = parent.parentElement;
          }
          return { questionText, required: el.required || el.getAttribute('aria-required') === 'true' };
        }).catch(() => ({ questionText: '', required: false }));

        if (!info.questionText) continue;

        // Generate a brief contextual answer based on the question and job title
        const answer = this._generateQuickScreeningAnswer(info.questionText, job.title);
        if (answer) {
          await this._fillTextarea(page, ta, answer);
          this._log('Filled screening question: "' + info.questionText.substring(0, 60) + '"');
        }
      }
    } catch (e) {
      this._log('Empty textarea fill warning: ' + e.message.substring(0, 60));
    }
  }

  _generateQuickScreeningAnswer(question, jobTitle) {
    const q = question.toLowerCase();

    if (q.includes('experience') || q.includes('similar project') || q.includes('relevant')) {
      return 'I have direct experience building similar systems. My production stack includes an AI orchestrator managing 19+ projects autonomously, 10 API endpoints on RapidAPI (web scraping, data extraction), automated trading bots (Coinbase, OANDA), and browser automation with Playwright. I run everything on a Mac Mini M4 Pro 24/7. My portfolio at brad.mccloskey-api.com has detailed case studies.';
    }
    if (q.includes('approach') || q.includes('how would you') || q.includes('methodology')) {
      return 'I start by auditing the existing setup and requirements, then build iteratively with frequent check-ins. I document everything, write tests for critical paths, and deliver maintainable code with clear documentation. Happy to discuss specifics on a call.';
    }
    if (q.includes('availability') || q.includes('start') || q.includes('hours') || q.includes('timeline')) {
      return 'I can start this week. I typically work 20-30 hours/week on client projects and am flexible on scheduling. I am based in the US (Eastern time) and responsive during business hours.';
    }
    if (q.includes('rate') || q.includes('budget') || q.includes('cost')) {
      return 'My rate is flexible based on scope and duration. Happy to discuss what makes sense for your project on a quick call.';
    }
    if (q.includes('why') || q.includes('interest') || q.includes('motivation')) {
      return 'This project aligns directly with my expertise and current production work. I enjoy building systems that run reliably in production, and I see clear value I can deliver here.';
    }

    // Generic fallback for any question
    return 'I have extensive experience in this area — my portfolio at brad.mccloskey-api.com showcases similar production systems I have built and maintain. I would be happy to discuss specifics on a call.';
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

    // Take pre-submit screenshot for debugging
    const preScreenshot = path.join(SCREENSHOT_DIR, `pre-submit-${job.uid}.png`);
    await page.screenshot({ path: preScreenshot, fullPage: false, timeout: 5000 }).catch(() => {});

    // Real submission — try multiple click strategies since Upwork's Vue.js SPA
    // may not respond to standard Playwright clicks
    this._log('Clicking submit button...');

    // Strategy 1: Scroll to button and use Playwright click
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);
    await submitBtn.click();
    await page.waitForTimeout(3000);

    // Handle fixed-price confirmation modal: "3 things you need to know"
    // This modal appears for fixed-price jobs and requires checking "Yes, I understand" + clicking "Continue"
    await this._handleFixedPriceModal(page);

    // Check if URL changed immediately
    if (!page.url().includes('/apply')) {
      // Submission worked via normal click
    } else {
      // Strategy 2: JavaScript direct click (bypasses any event interception)
      this._log('Standard click did not navigate — trying JS click...');
      await submitBtn.evaluate(el => el.click());
      await page.waitForTimeout(3000);
      await this._handleFixedPriceModal(page);
    }

    if (page.url().includes('/apply')) {
      // Strategy 3: Keyboard submit — focus button and press Enter
      this._log('JS click did not navigate — trying keyboard Enter...');
      await submitBtn.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
      await this._handleFixedPriceModal(page);
    }

    // Wait for confirmation — Upwork redirects or shows success UI after real submit
    let confirmed = false;
    let confirmMethod = '';

    // Method 1: URL change (most reliable — Upwork navigates away from /apply/)
    try {
      await page.waitForURL(
        url => !url.includes('/apply'),
        { timeout: SUBMIT_TIMEOUT }
      );
      confirmed = true;
      confirmMethod = 'url_change';
    } catch {}

    // Method 2: Check for specific Upwork success indicators (NOT broad CSS selectors)
    if (!confirmed) {
      const successChecks = await page.evaluate(() => {
        const body = document.body?.textContent || '';
        // Upwork shows these specific messages after successful proposal submission
        if (body.includes('Your proposal was submitted')) return 'proposal_submitted_text';
        if (body.includes('Proposal submitted')) return 'proposal_submitted_header';
        if (body.includes('You\'ve submitted a proposal')) return 'submitted_confirmation';
        // Check for the specific Upwork proposal-submitted data-test attribute
        if (document.querySelector('[data-test="proposal-submitted"]')) return 'data_test_attr';
        // Check if the submit button disappeared (form was accepted)
        const submitBtns = document.querySelectorAll('button');
        const hasSubmit = Array.from(submitBtns).some(b => /send for|submit proposal/i.test(b.textContent));
        if (!hasSubmit && body.includes('proposal')) return 'button_disappeared';
        return null;
      }).catch(() => null);

      if (successChecks) {
        confirmed = true;
        confirmMethod = successChecks;
      }
    }

    // Method 3: Check for validation errors (means form didn't submit — NOT confirmed)
    if (!confirmed) {
      const validationResult = await page.evaluate(() => {
        const body = document.body?.textContent || '';
        // Only match VISIBLE error banners, not hidden DOM text
        const errorBanner = document.querySelector('[class*="error-banner"], [class*="alert-error"], [role="alert"]');
        if (errorBanner && /fix the errors|required/i.test(errorBanner.textContent)) {
          return 'banner: ' + errorBanner.textContent.trim().substring(0, 80);
        }
        // Check for the specific Upwork validation banner text (must be prominent, not hidden)
        if (body.includes('Please fix the errors below')) return 'fix_errors_text';
        return null;
      }).catch(() => null);

      if (validationResult) {
        const errScreenshot = path.join(SCREENSHOT_DIR, `validation-error-${job.uid}.png`);
        await page.screenshot({ path: errScreenshot, fullPage: true, timeout: 5000 }).catch(() => {});
        throw new Error('VALIDATION_ERROR: ' + validationResult);
      }
    }

    // Take post-submit screenshot regardless
    const postScreenshot = path.join(SCREENSHOT_DIR, `post-submit-${job.uid}.png`);
    await page.screenshot({ path: postScreenshot, fullPage: true, timeout: 5000 }).catch(() => {});

    if (!confirmed) {
      throw new Error('SUBMIT_UNCONFIRMED: No success signal detected after submit click (post-submit screenshot saved)');
    }

    this._log('Submission confirmed via [' + confirmMethod + '] for job ' + job.uid + ' (URL: ' + page.url() + ')');
    return { success: true, dryRun: false };
  }

  async _handleFixedPriceModal(page) {
    // Upwork shows a "3 things you need to know" confirmation modal for fixed-price jobs.
    // It requires checking "Yes, I understand" checkbox, then clicking "Continue".
    // The checkbox is a custom Vue.js component — NOT a standard input[type="checkbox"].
    try {
      const hasModal = await page.evaluate(() => {
        const body = document.body?.textContent || '';
        return body.includes('3 things you need to know') || body.includes('Yes, I understand');
      }).catch(() => false);

      if (!hasModal) return;

      this._log('Fixed-price confirmation modal detected — accepting...');

      // Use page.evaluate() to interact with the checkbox directly in the DOM.
      // Upwork's custom checkbox may be: a label wrapping a hidden input, or a
      // div with click handler, or air3-checkbox component.
      const checkResult = await page.evaluate(() => {
        // Strategy 1: Find and click the label/container with "Yes, I understand" text
        const allEls = document.querySelectorAll('label, span, div, p');
        for (const el of allEls) {
          if (el.textContent.trim().startsWith('Yes, I understand') && el.childNodes.length <= 5) {
            el.click();
            return 'clicked_label';
          }
        }
        // Strategy 2: Find any checkbox input in a modal/dialog and check it
        const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]');
        for (const modal of modals) {
          const cb = modal.querySelector('input[type="checkbox"]');
          if (cb) {
            cb.checked = true;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            cb.dispatchEvent(new Event('input', { bubbles: true }));
            // Also click the label or parent
            const parent = cb.parentElement;
            if (parent) parent.click();
            return 'checked_input';
          }
        }
        // Strategy 3: Find any unchecked checkbox on page
        const cbs = document.querySelectorAll('input[type="checkbox"]');
        for (const cb of cbs) {
          if (!cb.checked) {
            cb.click();
            return 'clicked_checkbox';
          }
        }
        return null;
      }).catch(() => null);

      this._log('Checkbox result: ' + (checkResult || 'not_found'));
      await page.waitForTimeout(1000);

      // Click the "Continue" button (may be disabled until checkbox is checked)
      const continueBtn = page.locator('button:has-text("Continue")').first();
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        // Wait a moment for Vue.js reactivity to enable the button
        await page.waitForTimeout(500);
        const isDisabled = await continueBtn.isDisabled().catch(() => false);
        if (isDisabled) {
          // Button still disabled — try clicking checkbox via Playwright locator
          this._log('Continue button disabled — retrying checkbox click...');
          const yesLabel = page.locator('text="Yes, I understand"').first();
          await yesLabel.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
        await continueBtn.click({ timeout: 5000 });
        this._log('Fixed-price modal: clicked Continue');
        await page.waitForTimeout(5000);
      }
    } catch (e) {
      this._log('Fixed-price modal handling warning: ' + e.message.substring(0, 60));
    }
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
