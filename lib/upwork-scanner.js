'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const UpworkDB = require('./upwork-db');
const UpworkEvaluator = require('./upwork-evaluator');

const AUTH_STATE_PATH = path.join(__dirname, '..', '.upwork-auth.json');

/**
 * Convert a DB row (snake_case) back to a job object (camelCase) for scoreJob().
 */
function jobDataFromRow(row) {
  return {
    title: row.title,
    description: row.description,
    skills: row.skills,
    jobType: row.job_type,
    rateMin: row.rate_min,
    rateMax: row.rate_max,
    budget: row.budget,
    clientPaymentVerified: row.client_payment_verified,
    clientTotalSpent: row.client_total_spent,
    clientRating: row.client_rating,
    proposalsCount: row.proposals_count,
  };
}

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

    // Use real Chrome in headed mode to bypass Cloudflare bot detection.
    // Headless mode (both old and new) gets blocked by Cloudflare's challenge page.
    // Window is positioned off-screen so it doesn't clutter the desktop.
    this._browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-position=-9999,-9999',
        '--window-size=1280,900',
      ],
    });

    this._log('Browser launched (headed Chrome, off-screen)');
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

            // Score the job immediately after insertion
            const score = UpworkEvaluator.scoreJob(jobData);
            this._udb.updateJobMatchScore(jobData.uid, score);
          }
        }
      }

      // Scrape connects balance once per poll (piggyback on existing page)
      try {
        await this.getConnectsBalance(page);
      } catch (e) {
        this._log(`WARNING: Connects balance scrape failed: ${e.message}`);
      }

      // Detail-scrape up to 5 pending jobs per poll cycle
      try {
        const needsDetail = this._udb.getJobsNeedingDetail(5);
        for (const job of needsDetail) {
          try {
            const detail = await this._scrapeJobDetail(page, job.url);
            this._udb.updateJobDetail(job.uid, detail);

            // Re-score with enriched data
            const enriched = this._udb.getJobByUid(job.uid);
            if (enriched) {
              const score = UpworkEvaluator.scoreJob({
                ...jobDataFromRow(enriched),
                ...detail,
              });
              this._udb.updateJobMatchScore(job.uid, score);
            }

            this._log(`Detail scraped: ${job.uid} (${job.title.substring(0, 40)})`);
          } catch (e) {
            this._log(`WARNING: Detail scrape failed for ${job.uid}: ${e.message}`);
          }
        }
      } catch (e) {
        this._log(`WARNING: Detail scrape pass failed: ${e.message}`);
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
    const authExists = fs.existsSync(this._authPath);
    const authFresh = authExists &&
      (Date.now() - fs.statSync(this._authPath).mtimeMs < AUTH_MAX_AGE_MS);

    if (authFresh) {
      return this._browser.newContext({ storageState: this._authPath });
    }

    // No valid auth state — check if we can auto-login or need manual auth
    if (!process.env.UPWORK_EMAIL || !process.env.UPWORK_PASSWORD) {
      if (authExists) {
        // Auth file exists but is stale — try it anyway (Upwork sessions often last longer)
        this._log('Auth state is stale but no credentials for auto-login — trying stale session');
        return this._browser.newContext({ storageState: this._authPath });
      }
      throw new Error('AUTH_MISSING: No auth state and no credentials. Run: node scripts/upwork-auth.js');
    }

    // Perform email/password login
    const context = await this._browser.newContext();
    const page = await context.newPage();

    this._log('Auth state expired or missing — performing login');

    await page.goto('https://www.upwork.com/ab/account-security/login', { waitUntil: 'domcontentloaded' });
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

    // Wait for Cloudflare challenge to resolve (if present)
    await this._waitForCloudflare(page);

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
   * Detect and wait for Cloudflare challenge page to resolve.
   * Cloudflare shows a challenge page ("Challenge - Upwork" or "Just a moment...")
   * that auto-resolves via navigation when using real Chrome with valid cookies.
   *
   * @param {import('playwright').Page} page
   */
  async _waitForCloudflare(page) {
    let title = '';
    try { title = await page.title(); } catch { return; }

    const isChallenge = title.includes('Challenge') ||
                        title.includes('Just a moment') ||
                        title.includes('Attention Required');
    if (!isChallenge) return;

    this._log('Cloudflare challenge detected — waiting for resolution...');
    try {
      // Challenge resolves by navigating the page — wait for it
      await page.waitForURL(/upwork\.com/, { timeout: 30000 });
      await page.waitForLoadState('domcontentloaded');
      this._log('Cloudflare challenge resolved');
    } catch (e) {
      this._log(`WARNING: Cloudflare challenge wait failed: ${e.message.substring(0, 80)}`);
    }
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
  // Detail-page and connects scraping
  // ---------------------------------------------------------------------------

  /**
   * Scrape a job detail page for client info and screening questions.
   * Returns partial data if some fields can't be found.
   *
   * @param {import('playwright').Page} page
   * @param {string} jobUrl
   * @returns {{ clientPaymentVerified: number, clientRating: number|null, clientTotalSpent: string|null, screeningQuestions: string|null }}
   */
  async _scrapeJobDetail(page, jobUrl) {
    const result = { clientPaymentVerified: 0, clientRating: null, clientTotalSpent: null, screeningQuestions: null };

    try {
      await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._waitForCloudflare(page);

      // Check for auth redirect
      if (page.url().includes('/login')) {
        this._log('WARNING: Auth redirect on detail page');
        return result;
      }

      // Wait for main content
      await page.waitForSelector('[data-test="description"], .job-description', { timeout: 10000 }).catch(() => {});

      const detail = await page.evaluate(() => {
        const d = { paymentVerified: 0, rating: null, totalSpent: null, questions: null };

        // Payment verified — look for badge/text
        const paymentEls = document.querySelectorAll('[data-test*="payment"], [data-test*="verified"]');
        if (paymentEls.length > 0) {
          d.paymentVerified = 1;
        } else {
          // Fallback: search for text "Payment verified" or "Payment method verified"
          const allText = document.body.innerText;
          if (/payment\s+(method\s+)?verified/i.test(allText)) {
            d.paymentVerified = 1;
          }
        }

        // Client rating
        const ratingEl = document.querySelector('[data-test="client-rating"], .rating-value, [data-qa="client-rating"]');
        if (ratingEl) {
          const num = parseFloat(ratingEl.textContent.trim());
          if (!isNaN(num) && num >= 0 && num <= 5) d.rating = num;
        }
        if (d.rating === null) {
          // Fallback: look for star rating pattern
          const ratingMatch = document.body.innerText.match(/(\d+\.?\d*)\s*(?:of\s*5|\/\s*5|stars?)/i);
          if (ratingMatch) {
            const num = parseFloat(ratingMatch[1]);
            if (!isNaN(num) && num >= 0 && num <= 5) d.rating = num;
          }
        }

        // Client total spent
        const spentEl = document.querySelector('[data-test="client-spendings"], [data-test="total-spent"], [data-qa="client-spend"]');
        if (spentEl) {
          d.totalSpent = spentEl.textContent.trim();
        }
        if (!d.totalSpent) {
          // Fallback: look for "$XXK+" pattern near "spent"
          const spentMatch = document.body.innerText.match(/\$[\d,.]+[KkMm]?\+?\s*(?:spent|total)/i);
          if (spentMatch) d.totalSpent = spentMatch[0].replace(/\s*(spent|total)/i, '').trim();
        }

        // Screening questions
        const questionsEl = document.querySelector('[data-test="additional-questions"], [class*="questions"]');
        if (questionsEl) {
          const items = questionsEl.querySelectorAll('li, p, [class*="question"]');
          if (items.length > 0) {
            d.questions = Array.from(items).map(el => el.textContent.trim()).filter(Boolean).join('\n');
          } else {
            const text = questionsEl.textContent.trim();
            if (text) d.questions = text;
          }
        }
        if (!d.questions) {
          // Fallback: look for section heading with "question" and extract list
          const headings = document.querySelectorAll('h2, h3, h4, [class*="heading"]');
          for (const h of headings) {
            if (/question/i.test(h.textContent)) {
              const next = h.nextElementSibling;
              if (next) {
                const items = next.querySelectorAll('li');
                if (items.length > 0) {
                  d.questions = Array.from(items).map(el => el.textContent.trim()).filter(Boolean).join('\n');
                }
              }
              break;
            }
          }
        }

        return d;
      });

      result.clientPaymentVerified = detail.paymentVerified;
      result.clientRating = detail.rating;
      result.clientTotalSpent = detail.totalSpent;
      result.screeningQuestions = detail.questions;
    } catch (e) {
      this._log(`WARNING: Detail page error for ${jobUrl}: ${e.message}`);
    }

    return result;
  }

  /**
   * Scrape the current Upwork connects balance.
   * Navigates to Find Work page and extracts the connects number.
   *
   * @param {import('playwright').Page} page
   * @returns {number|null}
   */
  async getConnectsBalance(page) {
    try {
      // Navigate to Find Work if not already there
      const current = page.url();
      if (!current.includes('/nx/find-work')) {
        await page.goto('https://www.upwork.com/nx/find-work', { waitUntil: 'domcontentloaded', timeout: 20000 });
      }

      const balance = await page.evaluate(() => {
        // Try data-test selectors
        const selectors = [
          '[data-test="connects-balance"]',
          '[data-test="header-connects-balance"]',
          '[aria-label*="connects" i]',
        ];

        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const num = parseInt(el.textContent.trim(), 10);
            if (!isNaN(num)) return num;
          }
        }

        // Fallback: find number inside element with class containing "connect"
        const connectEls = document.querySelectorAll('[class*="connect"]');
        for (const el of connectEls) {
          const match = el.textContent.match(/(\d+)\s*(?:available|connects)/i);
          if (match) return parseInt(match[1], 10);
        }

        return null;
      });

      if (balance !== null) {
        this._udb.updateConnectsBalance(balance);
        this._log(`Connects balance: ${balance}`);
      }

      return balance;
    } catch (e) {
      this._log(`WARNING: Connects balance error: ${e.message}`);
      return null;
    }
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
