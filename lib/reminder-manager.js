'use strict';

const Database = require('better-sqlite3');
const path = require('path');

/**
 * ReminderManager - Persists and fires user reminders via SQLite.
 *
 * Uses the shared orchestrator.db (same as RevenueTracker, TrustTracker)
 * with lazy initialization. Reminders are polled every scan cycle (60s)
 * and fired via NotificationManager at URGENT tier (bypasses quiet hours).
 *
 * @example
 *   const rm = new ReminderManager({ config, notificationManager });
 *   rm.setReminder('Check YouTube OAuth', '2026-02-18T10:00:00-05:00');
 *   rm.checkAndFire(); // called every 60s from scan loop
 */
class ReminderManager {
  /**
   * @param {Object} deps
   * @param {Object} deps.config - Orchestrator config object
   * @param {Object} deps.notificationManager - NotificationManager instance for firing reminders
   */
  constructor({ config, notificationManager }) {
    this.config = config;
    this.notificationManager = notificationManager;
    this.db = null; // Lazy init
  }

  /**
   * Lazy SQLite initialization. Uses the SAME orchestrator.db as RevenueTracker/TrustTracker.
   * Creates reminders table if not exists.
   */
  _ensureDb() {
    if (this.db) return;
    const dbPath = path.join(__dirname, '..', 'orchestrator.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        fire_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        fired INTEGER DEFAULT 0,
        source_message TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_reminders_pending
      ON reminders(fired, fire_at)
    `);
  }

  /**
   * Store a new reminder.
   * @param {string} text - What to remind about
   * @param {string} fireAtISO - ISO 8601 timestamp when to fire
   * @param {string|null} sourceMessage - Original user SMS text (for audit)
   * @returns {number} The inserted reminder ID
   */
  setReminder(text, fireAtISO, sourceMessage = null) {
    this._ensureDb();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO reminders (text, fire_at, created_at, fired, source_message)
      VALUES (?, ?, ?, 0, ?)
    `);
    const result = stmt.run(text, fireAtISO, now, sourceMessage);
    return result.lastInsertRowid;
  }

  /**
   * Poll-based firing. Queries pending reminders where fire_at <= now,
   * sends each via notificationManager.notify() at URGENT tier (bypasses quiet hours),
   * and marks as fired.
   * @returns {number} Number of reminders fired
   */
  checkAndFire() {
    this._ensureDb();
    const now = new Date().toISOString();
    const pending = this.db.prepare(`
      SELECT id, text, fire_at, created_at FROM reminders
      WHERE fired = 0 AND fire_at <= ?
      ORDER BY fire_at ASC
    `).all(now);

    if (pending.length === 0) return 0;

    const markFired = this.db.prepare('UPDATE reminders SET fired = 1 WHERE id = ?');

    for (const reminder of pending) {
      const smsText = `Reminder: ${reminder.text}`;
      this.notificationManager.notify(smsText, 1); // tier 1 = URGENT (bypasses quiet hours)
      markFired.run(reminder.id);
    }

    return pending.length;
  }

  /**
   * List all unfired reminders sorted by fire_at ascending.
   * @returns {Array<Object>} Pending reminders
   */
  listPending() {
    this._ensureDb();
    return this.db.prepare(`
      SELECT id, text, fire_at, created_at FROM reminders
      WHERE fired = 0
      ORDER BY fire_at ASC
    `).all();
  }

  /**
   * Fuzzy-match cancellation. Marks matching pending reminders as fired.
   * @param {string} query - Text to fuzzy-match against reminder text
   * @returns {number} Number of reminders cancelled
   */
  cancelByText(query) {
    this._ensureDb();
    const result = this.db.prepare(`
      UPDATE reminders SET fired = 1
      WHERE fired = 0 AND text LIKE ?
    `).run(`%${query}%`);
    return result.changes;
  }

  /**
   * Close the SQLite database connection for graceful shutdown.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = ReminderManager;
