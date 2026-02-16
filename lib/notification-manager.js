/**
 * NotificationManager - Tier-based notification routing, batching, and daily SMS budgeting.
 *
 * Wraps the existing Messenger to add:
 * - 4 notification tiers (URGENT, ACTION, SUMMARY, DEBUG)
 * - Daily SMS budget enforcement with urgent bypass
 * - Batch queue for low-priority messages with interval flushing
 * - Quiet hours awareness (via Scheduler)
 *
 * @example
 *   const nm = new NotificationManager({ messenger, config, scheduler });
 *   nm.notify('Session crashed!', NotificationManager.URGENT);
 *   nm.notify('Started web-scraping-biz', NotificationManager.SUMMARY);
 *   nm.startBatchTimer();
 */
class NotificationManager {
  // Tier constants
  static URGENT = 1;
  static ACTION = 2;
  static SUMMARY = 3;
  static DEBUG = 4;

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
    this._dailyBudget = notifConfig.dailyBudget || 20;
    this._batchIntervalMs = notifConfig.batchIntervalMs || 14400000; // 4 hours
    this._urgentBypassQuiet = notifConfig.urgentBypassQuiet !== false; // default true

    // Runtime state
    this._dailySentCount = 0;
    this._budgetResetDate = this._getTodayDateStr();
    this._batchQueue = [];
    this._batchTimerId = null;
    this._budgetWarningLogged = false;
  }

  /**
   * Main entry point. Routes a notification based on its tier.
   * @param {string} text - Message text
   * @param {number} [tier=2] - Notification tier (1=URGENT, 2=ACTION, 3=SUMMARY, 4=DEBUG)
   */
  notify(text, tier = NotificationManager.ACTION) {
    this._resetBudgetIfNewDay();

    switch (tier) {
      case NotificationManager.URGENT:
        this._handleUrgent(text);
        break;
      case NotificationManager.ACTION:
        this._handleAction(text);
        break;
      case NotificationManager.SUMMARY:
        this._addToBatch(text);
        break;
      case NotificationManager.DEBUG:
        console.log(`[DEBUG NOTIFICATION] ${text}`);
        break;
      default:
        console.log(`[NOTIFICATION] Unknown tier ${tier}: ${text}`);
        break;
    }
  }

  /**
   * Tier 1 (URGENT): Send immediately. Bypass quiet hours if configured. Always bypass budget.
   * @param {string} text
   * @private
   */
  _handleUrgent(text) {
    const isQuiet = this.scheduler?.isQuietTime?.();

    if (isQuiet && !this._urgentBypassQuiet) {
      // Rare: urgentBypassQuiet is false, queue for wake
      this._addToBatch(`[URGENT] ${text}`);
      console.log(`[NOTIFICATION] Urgent queued (quiet hours, bypass disabled): ${text.substring(0, 80)}`);
      return;
    }

    // Urgent always sends, bypasses budget
    this._sendImmediate(text);

    // Piggyback: flush any batched messages while we're sending
    this._flushBatch();
  }

  /**
   * Tier 2 (ACTION): Send immediately during non-quiet hours. Queue if quiet. Counts against budget.
   * @param {string} text
   * @private
   */
  _handleAction(text) {
    const isQuiet = this.scheduler?.isQuietTime?.();

    if (isQuiet) {
      this._addToBatch(`[ACTION] ${text}`);
      console.log(`[NOTIFICATION] Action queued (quiet hours): ${text.substring(0, 80)}`);
      return;
    }

    const budget = this._checkBudget();
    if (!budget.ok) {
      // Budget exhausted -- downgrade to batch
      this._addToBatch(text);
      console.log(`[NOTIFICATION] Action downgraded to batch (budget exhausted): ${text.substring(0, 80)}`);
      return;
    }

    this._sendImmediate(text);

    // Piggyback: flush any batched messages
    this._flushBatch();
  }

  /**
   * Send a message immediately via the messenger. Increments daily sent count.
   * @param {string} text
   * @private
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
   * @param {string} text
   * @private
   */
  _addToBatch(text) {
    this._batchQueue.push(text);
    console.log(`[NOTIFICATION] Batched (queue size: ${this._batchQueue.length}): ${text.substring(0, 80)}`);
  }

  /**
   * Flush the batch queue. Formats all queued messages into a single SMS and sends.
   * Counts as 1 SMS against the daily budget. Truncates to 1500 chars.
   * @private
   */
  _flushBatch() {
    if (this._batchQueue.length === 0) return;

    const items = this._batchQueue.splice(0); // drain queue
    const header = `Batch update (${items.length} items):`;
    const body = items.map((item) => `- ${item}`).join("\n");
    let message = `${header}\n${body}`;

    // Truncate to 1500 chars
    if (message.length > 1500) {
      message = message.substring(0, 1497) + "...";
    }

    this._sendImmediate(message);
    console.log(`[NOTIFICATION] Batch flushed: ${items.length} items`);
  }

  /**
   * Check if daily SMS budget allows another message.
   * @returns {{ ok: boolean, remaining: number }}
   */
  _checkBudget() {
    this._resetBudgetIfNewDay();
    const remaining = this._dailyBudget - this._dailySentCount;
    return {
      ok: remaining > 0,
      remaining: Math.max(0, remaining),
    };
  }

  /**
   * Reset budget counter if the date has changed since last check.
   * @private
   */
  _resetBudgetIfNewDay() {
    const today = this._getTodayDateStr();
    if (today !== this._budgetResetDate) {
      this._dailySentCount = 0;
      this._budgetResetDate = today;
      this._budgetWarningLogged = false;
      console.log(`[NOTIFICATION] Daily budget reset for ${today}`);
    }
  }

  /**
   * Log a warning when budget hits 80%.
   * @private
   */
  _logBudgetWarning() {
    if (this._budgetWarningLogged) return;
    if (this._dailySentCount >= this._dailyBudget * 0.8) {
      console.warn(
        `[NOTIFICATION WARNING] Daily SMS budget 80% used (${this._dailySentCount}/${this._dailyBudget})`
      );
      this._budgetWarningLogged = true;
    }
  }

  /**
   * Get today's date as a string for budget tracking.
   * @returns {string} YYYY-MM-DD
   * @private
   */
  _getTodayDateStr() {
    return new Date().toISOString().split("T")[0];
  }

  /**
   * Start the batch flush timer. Flushes queued messages at the configured interval.
   * @returns {NodeJS.Timeout} The interval ID (for cleanup)
   */
  startBatchTimer() {
    if (this._batchTimerId) {
      clearInterval(this._batchTimerId);
    }
    this._batchTimerId = setInterval(() => {
      this._flushBatch();
    }, this._batchIntervalMs);
    console.log(
      `[NOTIFICATION] Batch timer started (interval: ${this._batchIntervalMs / 1000}s)`
    );
    return this._batchTimerId;
  }

  /**
   * Stop the batch flush timer.
   */
  stopBatchTimer() {
    if (this._batchTimerId) {
      clearInterval(this._batchTimerId);
      this._batchTimerId = null;
      console.log("[NOTIFICATION] Batch timer stopped");
    }
  }

  /**
   * Get notification statistics.
   * @returns {{ dailySent: number, dailyBudget: number, batchQueueSize: number, budgetRemaining: number }}
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
