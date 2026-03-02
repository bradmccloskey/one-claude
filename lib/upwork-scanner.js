'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const UpworkDB = require('./upwork-db');
const UpworkEvaluator = require('./upwork-evaluator');

// Apply stealth plugin once at module load
chromium.use(StealthPlugin());

const AUTH_STATE_PATH = path.join(__dirname, '..', '.upwork-auth.json');

/**
 * UpworkScanner — Authenticated Playwright browser scraper for Upwork job searches.
 *
 * Uses playwright-extra with stealth plugin to avoid bot detection.
 * Persists auth via Playwright storageState (cookies + localStorage).
 * Browser is launched once at init() and reused across poll() cycles.
 *
 * @param {Object} opts
 * @param {import('better-sqlite3').Database} opts.db - Open DB instance
 * @param {Object} opts.messenger - Messenger instance with send()
 * @param {Object} opts.config - Full CONFIG object (reads upwork block)
 */
class UpworkScanner {
  constructor({ db, messenger, config }) {
    this._udb = new UpworkDB(db);
    this._udb.ensureSchema();
    this._evaluator = new UpworkEvaluator();
    this._messenger = messenger;
    this._config = config;
    this._browser = null;
    this._authPath = AUTH_STATE_PATH;
  }

  /**
   * Launch the browser once. Call this at startup.
   * Browser instance is reused across all poll() cycles.
   */
  async init() {
    if (!process.env.UPWORK_EMAIL || !process.env.UPWORK_PASSWORD) {
      this._log('WARNING: UPWORK_EMAIL or UPWORK_PASSWORD not set — login will fail if auth state expires');
    }

    this._browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    this._log('Browser launched');
  }

  /**
   * Poll all configured search URLs. Returns aggregate counts.
   * Creates a new browser context per cycle (for storageState freshness).
   *
   * @returns {{ found: number, filtered: number, inserted: number }}
   */
  async poll() {
    const searches = this._config.upwork?.searches || [];
    if (!searches.length) return { found: 0, filtered: 0, inserted: 0 };

    const context = await this._getContext();
    const page = await context.newPage();

    let totalFound = 0;
    let totalFiltered = 0;
    let totalInserted = 0;
    const settings = this._udb.getSettings();

    try {
      for (const searchUrl of searches) {
        let cards;
        try {
          cards = await this._scanUrl(page, searchUrl);
        } catch (e) {
          if (e.message.startsWith('AUTH_EXPIRED')) {
            // Delete stale auth file so next poll forces re-login
            try { fs.unlinkSync(this._authPath); } catch {}
            if (this._messenger) {
              this._messenger.send('UPWORK: Session expired — re-login needed. Scanner paused until next poll.');
            }
            break; // Stop all searches this cycle
          }
          this._log(`ERROR scanning ${searchUrl}: ${e.message}`);
          continue;
        }

        totalFound += cards.length;

        for (const card of cards) {
          const jobData = {
            uid: card.uid,
            title: card.title,
            url: 'https://www.upwork.com' + (card.href.startsWith('/') ? card.href : '/' + card.href),
            jobType: this._parseJobType(card.budgetText),
            rateMin: this._parseRateMin(card.budgetText),
            rateMax: this._parseRateMax(card.budgetText),
            budget: this._parseBudget(card.budgetText),
            description: card.description || null,
            clientPaymentVerified: 0,
            clientTotalSpent: null,
            clientRating: null,
            proposalsCount: null,
            skills: '[]',
            status: 'new',
            filterReason: null,
            searchQuery: searchUrl,
          };

          // Evaluate job against filter settings
          const evalResult = this._evaluator.evaluate(jobData, settings);
          jobData.status = evalResult.status;
          jobData.filterReason = evalResult.reason;

          const inserted = this._udb.insertJob(jobData);
          if (inserted) {
            totalInserted++;
            if (evalResult.status === 'filtered') totalFiltered++;
          }
        }
      }
    } finally {
      await page.close();
      await context.close();
    }

    return { found: totalFound, filtered: totalFiltered, inserted: totalInserted };
  }

  /**
   * Close the browser. Call on shutdown.
   */
  async close() {
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
      this._log('Browser closed');
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Get an authenticated browser context.
   * Reuses storageState if auth file exists and is < maxAge old.
   * Otherwise performs a fresh login.
   */
  async _getContext() {
    const AUTH_MAX_AGE_MS = this._config.upwork?.authStateMaxAgeMs || 43200000; // 12h default
    const needsLogin = !fs.existsSync(this._authPath) ||
      (Date.now() - fs.statSync(this._authPath).mtimeMs > AUTH_MAX_AGE_MS);

    if (!needsLogin) {
      return this._browser.newContext({ storageState: this._authPath });
    }

    // Perform login
    const context = await this._browser.newContext();
    const page = await context.newPage();

    this._log('Auth state expired or missing — performing login');

    await page.goto('https://www.upwork.com/login', { waitUntil: 'domcontentloaded' });
    await page.fill('[name="login[username]"]', process.env.UPWORK_EMAIL);
    await page.click('[data-qa="btn-continue-with-email"]');
    await page.waitForSelector('[name="login[password]"]', { timeout: 10000 });
    await page.fill('[name="login[password]"]', process.env.UPWORK_PASSWORD);
    await page.click('[data-qa="btn-login"]');
    await page.waitForURL(/upwork\.com\/nx\/find-work/, { timeout: 30000 });

    await context.storageState({ path: this._authPath });
    this._log('Auth state saved');

    await page.close();
    return context;
  }

  /**
   * Navigate to a search URL and extract job cards.
   * Detects auth redirect and structural failures.
   *
   * @param {import('playwright').Page} page
   * @param {string} searchUrl
   * @returns {Array<{ uid: string, title: string, href: string, budgetText: string, description: string }>}
   */
  async _scanUrl(page, searchUrl) {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/account-security')) {
      throw new Error('AUTH_EXPIRED: Upwork session expired, redirected to login');
    }

    let cards;
    try {
      await page.waitForSelector('h2.job-tile-title', { timeout: 15000 });
      cards = await this._extractCards(page);
    } catch (e) {
      // Selector timeout — likely structural failure, not auth
      cards = [];
      this._log(`WARNING: No job cards found on ${searchUrl} — selector may have changed`);
    }

    return cards;
  }

  /**
   * Extract job card data from the current page via page.evaluate().
   * Primary selector: h2.job-tile-title a
   * Fallback: [data-test="job-tile"] a[href*="/jobs/~"]
   *
   * @param {import('playwright').Page} page
   * @returns {Array<{ uid: string, title: string, href: string, budgetText: string, description: string }>}
   */
  async _extractCards(page) {
    const cards = await page.evaluate(() => {
      // Try primary selector first
      let links = Array.from(document.querySelectorAll('h2.job-tile-title a'));

      // Fallback selector if primary yields nothing
      if (!links.length) {
        links = Array.from(document.querySelectorAll('[data-test="job-tile"] a[href*="/jobs/~"]'));
      }

      return links.map(link => {
        const href = link.getAttribute('href') || '';
        const uidMatch = href.match(/~([0-9a-f]+)/i);
        const uid = uidMatch ? uidMatch[1] : null;

        // Walk up to the card container for budget/description
        const card = link.closest('article, [data-test="job-tile"], .job-tile') || link.parentElement?.parentElement;

        // Budget text
        let budgetText = '';
        if (card) {
          const budgetEl = card.querySelector('[data-test="budget"]');
          if (budgetEl) {
            budgetText = budgetEl.textContent.trim();
          } else {
            const smallEl = card.querySelector('small');
            if (smallEl) {
              budgetText = smallEl.textContent.trim();
            }
          }
        }

        // Description snippet
        let description = '';
        if (card) {
          const descEl = card.querySelector('[data-test="job-description-text"], .job-description-text');
          if (descEl) {
            description = descEl.textContent.trim().slice(0, 500);
          }
        }

        return {
          uid,
          title: link.textContent.trim(),
          href,
          budgetText,
          description,
        };
      });
    });

    // Filter to only items where uid is non-null
    return cards.filter(c => c.uid);
  }

  // ---------------------------------------------------------------------------
  // Rate/budget parsing helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse job type from budget text.
   * @param {string} text
   * @returns {'hourly'|'fixed'|'unknown'}
   */
  _parseJobType(text) {
    if (!text) return 'unknown';
    if (/hr|hourly/i.test(text)) return 'hourly';
    if (/\$/.test(text)) return 'fixed';
    return 'unknown';
  }

  /**
   * Extract minimum hourly rate from budget text.
   * @param {string} text
   * @returns {number|null}
   */
  _parseRateMin(text) {
    if (!text || !/hr|hourly/i.test(text)) return null;
    const numbers = text.match(/\$?([\d,]+\.?\d*)/g)
      ?.map(n => parseFloat(n.replace(/[$,]/g, '')))
      ?.filter(n => !isNaN(n)) || [];
    return numbers.length >= 1 ? numbers[0] : null;
  }

  /**
   * Extract maximum hourly rate from budget text.
   * @param {string} text
   * @returns {number|null}
   */
  _parseRateMax(text) {
    if (!text || !/hr|hourly/i.test(text)) return null;
    const numbers = text.match(/\$?([\d,]+\.?\d*)/g)
      ?.map(n => parseFloat(n.replace(/[$,]/g, '')))
      ?.filter(n => !isNaN(n)) || [];
    if (numbers.length >= 2) return numbers[1];
    if (numbers.length === 1) return numbers[0];
    return null;
  }

  /**
   * Extract fixed-price budget amount.
   * @param {string} text
   * @returns {number|null}
   */
  _parseBudget(text) {
    if (!text) return null;
    // Only extract budget for non-hourly jobs
    if (/hr|hourly/i.test(text)) return null;
    const numbers = text.match(/\$?([\d,]+\.?\d*)/g)
      ?.map(n => parseFloat(n.replace(/[$,]/g, '')))
      ?.filter(n => !isNaN(n)) || [];
    return numbers.length >= 1 ? numbers[0] : null;
  }

  /**
   * Simple prefixed logger.
   * @param {string} msg
   */
  _log(msg) {
    console.log(`[UPWORK] ${msg}`);
  }
}

module.exports = UpworkScanner;
