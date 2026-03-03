/**
 * NotificationManager - 2-tier notification routing with batching and daily SMS budget.
 *
 * v4.0: Simplified from 4 tiers to 2:
 *   URGENT (1) — Send immediately, bypass quiet hours and budget
 *   BATCH (2)  — Queue for batch delivery at next flush interval
 *
 * Wraps the Messenger to add:
 * - Daily SMS budget enforcement with urgent bypass
 * - Batch queue for non-urgent messages with interval flushing
 * - Quiet hours awareness (via Scheduler)
 *
 * @example
 *   const nm = new NotificationManager({ messenger, config, scheduler });
 *   nm.notify('Session crashed!', NotificationManager.URGENT);
 *   nm.notify('Started web-scraping-biz', NotificationManager.BATCH);
 *   nm.startBatchTimer();
 */
class NotificationManager {
  // Tier constants
  static URGENT = 1;
  static BATCH = 2;

  // Backwards compatibility aliases
  static ACTION = 2;
  static SUMMARY = 2;
  static DEBUG = 2;

  /**
   * @param {Object} opts
   * @param {Object} opts.messenger - Messenger instance with send(text) method
   * @param {Object} opts.config - Full config object (reads ai.notifications)
   * @param {Object} opts.scheduler - Scheduler instance with isQuietTime() method
   */
  constructor({ messenger, config, scheduler }) {
    this.messenger = messenger;
    this.config = config;
    this.scheduler = scheduler;

    // Notification config with defaults
    const notifConfig = config.ai?.notifications || {};
    this._dailyBudget = notifConfig.dailyBudget || 10;
    this._batchIntervalMs = notifConfig.batchIntervalMs || 14400000; // 4 hours
    this._urgentBypassQuiet = notifConfig.urgentBypassQuiet !== false;

    // Runtime state
    this._dailySentCount = 0;
    this._budgetResetDate = this._getTodayDateStr();
    this._batchQueue = [];
    this._batchTimerId = null;
    this._budgetWarningLogged = false;
  }

  // Map string tier names to numeric constants (backwards compat with old callers)
  static TIER_MAP = {
    urgent: 1, critical: 1, emergency: 1,
    action: 2, important: 2, high: 2, batch: 2,
    summary: 2, info: 2, low: 2, sms: 2,
    debug: 2, silent: 2, log: 2,
  };

  /**
   * Main entry point. Routes a notification based on its tier.
   * @param {string} text - Message text
   * @param {number} [tier=2] - Notification tier (1=URGENT, 2=BATCH)
   */
  notify(text, tier = NotificationManager.BATCH) {
    // Normalize string tiers to numeric
    if (typeof tier === 'string') {
      tier = NotificationManager.TIER_MAP[tier.toLowerCase()] || NotificationManager.BATCH;
    }

    this._resetBudgetIfNewDay();

    if (tier === NotificationManager.URGENT) {
      this._handleUrgent(text);
    } else {
      this._addToBatch(text);
    }
  }

  /**
   * URGENT: Send immediately. Bypass quiet hours if configured. Always bypass budget.
   */
  _handleUrgent(text) {
    const isQuiet = this.scheduler?.isQuietTime?.();

    if (isQuiet && !this._urgentBypassQuiet) {
      this._addToBatch(`[URGENT] ${text}`);
      console.log(`[NOTIFICATION] Urgent queued (quiet hours, bypass disabled): ${text.substring(0, 80)}`);
      return;
    }

    this._sendImmediate(text);
    this._flushBatch();
  }

  /**
   * Send a message immediately via the messenger. Increments daily sent count.
   */
  _sendImmediate(text) {
    try {
      this.messenger.send(text);
    } catch (err) {
      console.error(`[NOTIFICATION SEND ERROR] ${err.message}`);
    }
    this._dailySentCount++;
    this._logBudgetWarning();
  }

  /**
   * Add a message to the batch queue.
   */
  _addToBatch(text) {
    this._batchQueue.push(text);
    console.log(`[NOTIFICATION] Batched (queue size: ${this._batchQueue.length}): ${text.substring(0, 80)}`);
  }

  /**
   * Flush the batch queue. Formats all queued messages into a single SMS and sends.
   * Counts as 1 SMS against the daily budget. Truncates to 1500 chars.
   */
  _flushBatch() {
    if (this._batchQueue.length === 0) return;

    // Check budget before flushing
    const budget = this._checkBudget();
    if (!budget.ok) {
      console.log(`[NOTIFICATION] Batch flush deferred (budget exhausted, ${this._batchQueue.length} queued)`);
      return;
    }

    const items = this._batchQueue.splice(0);

    const cleanItems = items.map((item) => {
      return item
        .replace(/\n/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .substring(0, 200);
    });

    const header = `Batch (${cleanItems.length}):`;
    const body = cleanItems.map((item) => `- ${item}`).join('\n');
    let message = `${header}\n${body}`;

    if (message.length > 1500) {
      message = message.substring(0, 1497) + '...';
    }

    this._sendImmediate(message);
    console.log(`[NOTIFICATION] Batch flushed: ${items.length} items`);
  }

  _checkBudget() {
    this._resetBudgetIfNewDay();
    const remaining = this._dailyBudget - this._dailySentCount;
    return { ok: remaining > 0, remaining: Math.max(0, remaining) };
  }

  _resetBudgetIfNewDay() {
    const today = this._getTodayDateStr();
    if (today !== this._budgetResetDate) {
      this._dailySentCount = 0;
      this._budgetResetDate = today;
      this._budgetWarningLogged = false;
      console.log(`[NOTIFICATION] Daily budget reset for ${today}`);
    }
  }

  _logBudgetWarning() {
    if (this._budgetWarningLogged) return;
    if (this._dailySentCount >= this._dailyBudget * 0.8) {
      console.warn(`[NOTIFICATION WARNING] Daily SMS budget 80% used (${this._dailySentCount}/${this._dailyBudget})`);
      this._budgetWarningLogged = true;
    }
  }

  _getTodayDateStr() {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Start the batch flush timer.
   */
  startBatchTimer() {
    if (this._batchTimerId) clearInterval(this._batchTimerId);
    this._batchTimerId = setInterval(() => this._flushBatch(), this._batchIntervalMs);
    console.log(`[NOTIFICATION] Batch timer started (interval: ${this._batchIntervalMs / 1000}s)`);
    return this._batchTimerId;
  }

  /**
   * Stop the batch flush timer.
   */
  stopBatchTimer() {
    if (this._batchTimerId) {
      clearInterval(this._batchTimerId);
      this._batchTimerId = null;
      console.log('[NOTIFICATION] Batch timer stopped');
    }
  }

  /**
   * Get notification statistics.
   */
  getStats() {
    this._resetBudgetIfNewDay();
    return {
      dailySent: this._dailySentCount,
      dailyBudget: this._dailyBudget,
      batchQueueSize: this._batchQueue.length,
      budgetRemaining: Math.max(0, this._dailyBudget - this._dailySentCount),
    };
  }
}

module.exports = NotificationManager;
