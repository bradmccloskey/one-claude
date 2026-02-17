const cron = require("node-cron");

/**
 * Scheduler - Manages cron jobs for morning digest and quiet hours enforcement.
 */
class Scheduler {
  constructor(config) {
    this.config = config;
    this._quietOverride = false;
    this._jobs = [];
  }

  /**
   * Start the morning digest cron job
   * @param {Function} digestCallback - Called when it's time to send digest
   */
  startMorningDigest(digestCallback) {
    if (!this.config.morningDigest.enabled) return;

    const job = cron.schedule(
      this.config.morningDigest.cron,
      () => {
        if (!this.isQuietTime()) {
          console.log(`[${new Date().toISOString()}] Sending morning digest...`);
          digestCallback();
        } else {
          console.log(`[${new Date().toISOString()}] Skipping digest - quiet hours`);
        }
      },
      { timezone: this.config.morningDigest.timezone }
    );

    this._jobs.push(job);
    console.log(`[SCHEDULER] Morning digest: ${this.config.morningDigest.cron} (${this.config.morningDigest.timezone})`);
  }

  /**
   * Check if we're currently in quiet hours
   * @returns {boolean}
   */
  isQuietTime() {
    if (this._quietOverride) return true;
    if (!this.config.quietHours.enabled) return false;

    const now = new Date();
    // Get current time in configured timezone
    const timeStr = now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      timeZone: this.config.quietHours.timezone,
    });

    const [startH, startM] = this.config.quietHours.start.split(":").map(Number);
    const [endH, endM] = this.config.quietHours.end.split(":").map(Number);
    const [nowH, nowM] = timeStr.split(":").map(Number);

    const nowMinutes = nowH * 60 + nowM;
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Handle overnight quiet hours (e.g., 22:00 - 07:00)
    if (startMinutes > endMinutes) {
      return nowMinutes >= startMinutes || nowMinutes < endMinutes;
    }
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  /**
   * Start the evening digest cron job
   * @param {Function} callback - Called when it's time to send evening digest
   */
  startEveningDigest(callback) {
    const cronExpr = this.config.eveningDigest?.cron || '45 21 * * *';
    const tz = this.config.eveningDigest?.timezone || this.config.quietHours?.timezone || 'America/New_York';

    if (!this.config.eveningDigest?.enabled) return;

    const job = cron.schedule(
      cronExpr,
      () => {
        console.log(`[${new Date().toISOString()}] Sending evening digest...`);
        callback();
      },
      { timezone: tz }
    );

    this._jobs.push(job);
    console.log(`[SCHEDULER] Evening digest: ${cronExpr} (${tz})`);
  }

  /**
   * Start the weekly revenue summary cron job
   * @param {Function} callback - Called when it's time to send weekly summary
   */
  startWeeklySummary(callback) {
    const cronExpr = this.config.weeklyRevenue?.cron || '0 7 * * 0';
    const tz = this.config.weeklyRevenue?.timezone || this.config.quietHours?.timezone || 'America/New_York';

    if (!this.config.weeklyRevenue?.enabled) return;

    const job = cron.schedule(
      cronExpr,
      () => {
        console.log(`[${new Date().toISOString()}] Sending weekly revenue summary...`);
        callback();
      },
      { timezone: tz }
    );

    this._jobs.push(job);
    console.log(`[SCHEDULER] Weekly revenue summary: ${cronExpr} (${tz})`);
  }

  /**
   * Manually override quiet mode
   * @param {boolean} quiet
   */
  setQuietOverride(quiet) {
    this._quietOverride = quiet;
  }

  /**
   * Stop all scheduled jobs
   */
  stop() {
    for (const job of this._jobs) {
      job.stop();
    }
    this._jobs = [];
  }
}

module.exports = Scheduler;
