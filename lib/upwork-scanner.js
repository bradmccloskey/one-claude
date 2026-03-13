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
        '--window-position=2560,0',
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

    const context = await this.getContext();
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

      // Detail-scrape pending jobs per poll cycle (15 for initial catch-up, reduce later)
      try {
        const needsDetail = this._udb.getJobsNeedingDetail(15);
        for (const job of needsDetail) {
          try {
            const detail = await this._scrapeJobDetail(page, job.url);
            this._udb.updateJobDetail(job.uid, detail);

            // Re-evaluate and re-score with enriched data
            const enriched = this._udb.getJobByUid(job.uid);
            if (enriched) {
              const jobData = { ...jobDataFromRow(enriched), ...detail };

              // Re-evaluate filters now that we have full description + correct job type
              const evalResult = this._evaluator.evaluate(jobData, settings);
              if (evalResult.status === 'filtered') {
                this._udb.updateJobStatus(job.uid, 'filtered', evalResult.reason);
              }

              const score = UpworkEvaluator.scoreJob(jobData);
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
  async getContext() {
    const AUTH_MAX_AGE_MS = this._config.upwork?.authStateMaxAgeMs || 43200000; // 12h default
    const authExists = fs.existsSync(this._authPath);
    const authFresh = authExists &&
      (Date.now() - fs.statSync(this._authPath).mtimeMs < AUTH_MAX_AGE_MS);

    if (authFresh) {
      return this._browser.newContext({ storageState: this._authPath });
    }

    // Auth is stale or missing — always try stale auth first before login attempt
    if (authExists) {
      this._log('Auth state is stale — trying stale session first');
      const staleCtx = await this._browser.newContext({ storageState: this._authPath });
      const testPage = await staleCtx.newPage();
      try {
        await testPage.goto('https://www.upwork.com/nx/find-work/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await this.waitForCloudflare(testPage);
        const url = testPage.url();
        if (!url.includes('/login') && !url.includes('/account-security')) {
          this._log('Stale auth still valid — refreshing timestamp');
          await staleCtx.storageState({ path: this._authPath });
          await testPage.close();
          return staleCtx;
        }
        this._log('Stale auth expired — redirected to login');
      } catch (e) {
        this._log(`Stale auth test failed: ${e.message}`);
      }
      await testPage.close();
      await staleCtx.close();
    }

    // No valid auth — check if we can auto-login
    if (!process.env.UPWORK_EMAIL || !process.env.UPWORK_PASSWORD) {
      throw new Error('AUTH_MISSING: No auth state and no credentials. Run: node scripts/upwork-auth.js');
    }

    // Perform email/password login with resilient selectors
    const context = await this._browser.newContext();
    const page = await context.newPage();

    this._log('Performing email/password login');

    await page.goto('https://www.upwork.com/ab/account-security/login', { waitUntil: 'domcontentloaded' });
    await this.waitForCloudflare(page);

    // Fill username — try multiple selectors for resilience
    const usernameSelector = '[name="login[username]"], #login_username, input[type="email"]';
    await page.fill(usernameSelector, process.env.UPWORK_EMAIL);

    // Click continue — try multiple selectors
    const continueSelector = '[data-qa="btn-continue-with-email"], button[type="submit"], #login_password_continue';
    try {
      await page.click(continueSelector, { timeout: 10000 });
    } catch {
      // Some login flows show email+password on one page
      this._log('Continue button not found — trying single-page login');
    }

    // Fill password
    const passwordSelector = '[name="login[password]"], #login_password, input[type="password"]';
    await page.waitForSelector(passwordSelector, { timeout: 15000 });
    await page.fill(passwordSelector, process.env.UPWORK_PASSWORD);

    // Click login
    const loginSelector = '[data-qa="btn-login"], button[type="submit"]:visible, #login_control_continue';
    await page.click(loginSelector, { timeout: 10000 });
    await page.waitForURL(/upwork\.com\/nx\/find-work/, { timeout: 30000 });

    await context.storageState({ path: this._authPath });
    this._log('Auth state saved after login');

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
    await this.waitForCloudflare(page);

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
  async waitForCloudflare(page) {
    let title = '';
    try { title = await page.title(); } catch { return; }

    const isChallenge = title.includes('Challenge') ||
                        title.includes('Just a moment') ||
                        title.includes('Attention Required');
    if (!isChallenge) return;

    this._log('Cloudflare challenge detected — waiting for resolution...');
    const deadline = Date.now() + 45000;

    // Simulate mouse movement to help Turnstile detect human activity
    const moveMouseRandomly = async () => {
      try {
        const x = 300 + Math.floor(Math.random() * 600);
        const y = 200 + Math.floor(Math.random() * 400);
        await page.mouse.move(x, y, { steps: 5 });
      } catch {}
    };

    let turnstileAttempts = 0;
    while (Date.now() < deadline) {
      await moveMouseRandomly();
      await new Promise(r => setTimeout(r, 1500));

      // Try to click Cloudflare Turnstile checkbox if present
      if (turnstileAttempts < 3) {
        try {
          const frames = page.frames();
          const cfFrame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
          if (cfFrame) {
            // Try multiple selectors for the checkbox
            const checkbox = await cfFrame.$('input[type="checkbox"], .cb-lb, label, [role="checkbox"]');
            if (checkbox) {
              const box = await checkbox.boundingBox();
              if (box) {
                // Click at the center of the checkbox with a small random offset
                await page.mouse.click(
                  box.x + box.width / 2 + (Math.random() * 4 - 2),
                  box.y + box.height / 2 + (Math.random() * 4 - 2)
                );
                this._log('Clicked Cloudflare Turnstile checkbox');
                turnstileAttempts++;
                await new Promise(r => setTimeout(r, 3000));
              }
            }
          }
        } catch {}
      }

      try {
        const currentTitle = await page.title();
        if (!currentTitle.includes('Challenge') &&
            !currentTitle.includes('Just a moment') &&
            !currentTitle.includes('Attention Required')) {
          this._log('Cloudflare challenge resolved');
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          return;
        }
      } catch {
        // Context destroyed = page navigated = challenge resolving
        await new Promise(r => setTimeout(r, 2000));
        try {
          await page.waitForLoadState('domcontentloaded');
          this._log('Cloudflare challenge resolved (via navigation)');
          return;
        } catch { break; }
      }
    }
    this._log('WARNING: Cloudflare challenge did not resolve within 45s');
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
   * Scrape a job detail page for full description, skills, client info, and screening questions.
   * Returns partial data if some fields can't be found.
   *
   * @param {import('playwright').Page} page
   * @param {string} jobUrl
   * @returns {{ description: string|null, skills: string|null, jobType: string|null, budget: number|null, rateMin: number|null, rateMax: number|null, proposalsCount: string|null, clientPaymentVerified: number, clientRating: number|null, clientTotalSpent: string|null, screeningQuestions: string|null }}
   */
  async _scrapeJobDetail(page, jobUrl) {
    const result = {
      description: null, skills: null, jobType: null,
      budget: null, rateMin: null, rateMax: null,
      proposalsCount: null,
      clientPaymentVerified: 0, clientRating: null, clientTotalSpent: null,
      screeningQuestions: null,
    };

    try {
      await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.waitForCloudflare(page);

      // Check for auth redirect
      if (page.url().includes('/login')) {
        this._log('WARNING: Auth redirect on detail page');
        return result;
      }

      // Wait for main content
      await page.waitForSelector('[data-test="Description"], [data-cy="job"]', { timeout: 10000 }).catch(() => {});

      const detail = await page.evaluate(() => {
        const d = {
          description: null, skills: [], jobType: null,
          budgetText: null, proposalsCount: null,
          paymentVerified: 0, rating: null, totalSpent: null,
          questions: null,
        };

        // --- Full description ---
        const descEl = document.querySelector('[data-test="Description"]');
        if (descEl) {
          let text = descEl.textContent.trim();
          // Strip leading "Summary" label if present
          text = text.replace(/^Summary\s*/i, '');
          if (text) d.description = text;
        }

        // --- Skills ---
        const skillBadges = document.querySelectorAll('.skills-list .air3-badge');
        if (skillBadges.length > 0) {
          d.skills = Array.from(skillBadges).map(el => el.textContent.trim()).filter(Boolean);
        } else {
          // Fallback: look for any badge-like elements inside a skills section
          const skillSection = Array.from(document.querySelectorAll('h2,h3,h4,h5')).find(h => /skill/i.test(h.textContent));
          if (skillSection) {
            const container = skillSection.closest('section') || skillSection.parentElement;
            const badges = container?.querySelectorAll('.air3-badge, [class*="badge"], a[href*="ontology_skill"]');
            if (badges?.length) {
              d.skills = Array.from(badges).map(el => el.textContent.trim()).filter(Boolean);
            }
          }
        }

        // --- Job type and budget from features list ---
        const fixedPriceEl = document.querySelector('[data-cy="fixed-price"]');
        const hourlyEl = document.querySelector('[data-cy="hourly"]');
        if (fixedPriceEl) {
          d.jobType = 'fixed';
          const li = fixedPriceEl.closest('li');
          if (li) d.budgetText = li.textContent.trim();
        } else if (hourlyEl) {
          d.jobType = 'hourly';
          const li = hourlyEl.closest('li');
          if (li) d.budgetText = li.textContent.trim();
        } else {
          // Fallback: check stats element or features text
          const statsEl = document.querySelector('[data-cy="stats"]');
          const statsText = statsEl?.textContent.trim() || '';
          if (/fixed/i.test(statsText)) d.jobType = 'fixed';
          else if (/hourly/i.test(statsText)) d.jobType = 'hourly';

          // Also check features list
          const featuresLi = document.querySelector('.features li');
          if (featuresLi) d.budgetText = featuresLi.textContent.trim();
        }

        // --- Proposals count ---
        const activityHeading = Array.from(document.querySelectorAll('h2,h3,h4,h5')).find(h => /activity/i.test(h.textContent));
        if (activityHeading) {
          const actSection = activityHeading.closest('section') || activityHeading.parentElement;
          const items = actSection?.querySelectorAll('li');
          if (items) {
            for (const li of items) {
              const text = li.textContent.trim();
              if (/proposal/i.test(text)) {
                // Extract "15 to 20" or "Less than 5" etc.
                const countMatch = text.match(/(\d+\s*to\s*\d+|less\s+than\s+\d+|\d+)/i);
                if (countMatch) d.proposalsCount = countMatch[0];
                break;
              }
            }
          }
        }

        // --- Client info from about-client section ---
        const clientSection = document.querySelector('[data-test="about-client-container"]');
        const clientText = clientSection?.textContent || document.body.innerText;

        // Payment verified
        if (/payment\s+(method\s+)?verified/i.test(clientText)) {
          d.paymentVerified = 1;
        }

        // Client rating — look for "Rating is X.X out of 5" pattern
        const ratingMatch = clientText.match(/Rating\s+is\s+(\d+\.?\d*)\s+out\s+of\s+5/i);
        if (ratingMatch) {
          const num = parseFloat(ratingMatch[1]);
          if (!isNaN(num) && num >= 0 && num <= 5) d.rating = num;
        }
        if (d.rating === null) {
          // Fallback: "X.X of N reviews" pattern
          const altMatch = clientText.match(/(\d+\.?\d*)\s+of\s+\d+\s+reviews/i);
          if (altMatch) {
            const num = parseFloat(altMatch[1]);
            if (!isNaN(num) && num >= 0 && num <= 5) d.rating = num;
          }
        }

        // Client total spent — "$X.XK total spent" pattern
        const spentMatch = clientText.match(/(\$[\d,.]+[KkMm]?\+?)\s*total\s*spent/i);
        if (spentMatch) {
          d.totalSpent = spentMatch[1].trim();
        }

        // --- Screening questions ---
        const questionsEl = document.querySelector('[data-test="additional-questions"], [class*="screening-questions"]');
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
          const headings = document.querySelectorAll('h2, h3, h4, h5, [class*="heading"]');
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

      // Map page.evaluate results to our result object
      result.description = detail.description;
      result.skills = detail.skills?.length ? JSON.stringify(detail.skills) : null;
      result.jobType = detail.jobType;
      result.proposalsCount = detail.proposalsCount;
      result.clientPaymentVerified = detail.paymentVerified;
      result.clientRating = detail.rating;
      result.clientTotalSpent = detail.totalSpent;
      result.screeningQuestions = detail.questions;

      // Parse budget/rates from budgetText
      if (detail.budgetText) {
        if (detail.jobType === 'hourly') {
          const rates = detail.budgetText.match(/\$?([\d,]+\.?\d*)/g)
            ?.map(n => parseFloat(n.replace(/[$,]/g, '')))
            ?.filter(n => !isNaN(n)) || [];
          if (rates.length >= 2) { result.rateMin = rates[0]; result.rateMax = rates[1]; }
          else if (rates.length === 1) { result.rateMin = rates[0]; result.rateMax = rates[0]; }
        } else if (detail.jobType === 'fixed') {
          const amounts = detail.budgetText.match(/\$?([\d,]+\.?\d*)/g)
            ?.map(n => parseFloat(n.replace(/[$,]/g, '')))
            ?.filter(n => !isNaN(n)) || [];
          if (amounts.length >= 1) result.budget = amounts[0];
        }
      }
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
