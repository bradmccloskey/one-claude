'use strict';

/**
 * UpworkDB — SQLite schema and helpers for the Upwork job pipeline.
 *
 * Takes a pre-opened better-sqlite3 Database instance (shared with the
 * orchestrator). Does NOT open its own connection or set WAL pragma —
 * that is handled by the caller (scan-db.js already sets WAL on the
 * shared connection).
 *
 * Tables:
 *   upwork_jobs       — scraped job listings (deduped by uid)
 *   upwork_proposals  — draft/submitted cover letters linked to jobs
 *   upwork_settings   — key/value config (rate floor, filter flags)
 */
class UpworkDB {
  /**
   * @param {import('better-sqlite3').Database} db - Open DB instance
   */
  constructor(db) {
    this._db = db;
  }

  /**
   * Create tables + indexes + seed settings if not present.
   * Idempotent — safe to call on every startup.
   */
  ensureSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS upwork_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        job_type TEXT,
        rate_min REAL,
        rate_max REAL,
        budget REAL,
        client_payment_verified INTEGER DEFAULT 0,
        client_total_spent TEXT,
        client_rating REAL,
        proposals_count TEXT,
        description TEXT,
        skills TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        filter_reason TEXT,
        search_query TEXT,
        found_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_upwork_jobs_uid ON upwork_jobs(uid);
      CREATE INDEX IF NOT EXISTS idx_upwork_jobs_status ON upwork_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_upwork_jobs_found_at ON upwork_jobs(found_at);

      CREATE TABLE IF NOT EXISTS upwork_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES upwork_jobs(id),
        cover_letter TEXT,
        bid_rate REAL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        submitted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS upwork_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT OR IGNORE INTO upwork_settings (key, value) VALUES
        ('rate_floor_hourly', '40'),
        ('require_payment_verified', '0'),
        ('min_client_spent', '0'),
        ('poll_enabled', '1');
    `);
  }

  /**
   * Insert a job listing. Silently ignores duplicate uid (DB-level dedup).
   *
   * @param {Object} job
   * @param {string} job.uid
   * @param {string} job.title
   * @param {string} job.url
   * @param {string|null} job.jobType
   * @param {number|null} job.rateMin
   * @param {number|null} job.rateMax
   * @param {number|null} job.budget
   * @param {string|null} job.description
   * @param {number} job.clientPaymentVerified
   * @param {string|null} job.clientTotalSpent
   * @param {number|null} job.clientRating
   * @param {string|null} job.proposalsCount
   * @param {string|null} job.skills - JSON array string
   * @param {string} job.status
   * @param {string|null} job.filterReason
   * @param {string|null} job.searchQuery
   * @returns {boolean} true if inserted, false if duplicate
   */
  insertJob(job) {
    const stmt = this._db.prepare(`
      INSERT OR IGNORE INTO upwork_jobs
        (uid, title, url, job_type, rate_min, rate_max, budget, description,
         client_payment_verified, client_total_spent, client_rating,
         proposals_count, skills, status, filter_reason, search_query)
      VALUES
        (@uid, @title, @url, @jobType, @rateMin, @rateMax, @budget, @description,
         @clientPaymentVerified, @clientTotalSpent, @clientRating,
         @proposalsCount, @skills, @status, @filterReason, @searchQuery)
    `);
    const result = stmt.run({
      uid: job.uid,
      title: job.title,
      url: job.url,
      jobType: job.jobType || null,
      rateMin: job.rateMin != null ? job.rateMin : null,
      rateMax: job.rateMax != null ? job.rateMax : null,
      budget: job.budget != null ? job.budget : null,
      description: job.description || null,
      clientPaymentVerified: job.clientPaymentVerified || 0,
      clientTotalSpent: job.clientTotalSpent || null,
      clientRating: job.clientRating != null ? job.clientRating : null,
      proposalsCount: job.proposalsCount || null,
      skills: job.skills || null,
      status: job.status || 'new',
      filterReason: job.filterReason || null,
      searchQuery: job.searchQuery || null,
    });
    return result.changes > 0;
  }

  /**
   * Get all settings as a plain key/value object.
   * @returns {{ rate_floor_hourly: string, require_payment_verified: string, min_client_spent: string, poll_enabled: string }}
   */
  getSettings() {
    const rows = this._db.prepare('SELECT key, value FROM upwork_settings').all();
    return rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
  }

  /**
   * Get the most recently found jobs.
   * @param {number} [limit=20]
   * @returns {Object[]}
   */
  getRecentJobs(limit = 20) {
    return this._db.prepare(
      'SELECT * FROM upwork_jobs ORDER BY found_at DESC LIMIT ?'
    ).all(limit);
  }

  /**
   * Update a job's status and optional filter reason.
   * @param {string} uid
   * @param {string} status
   * @param {string|null} [filterReason=null]
   */
  updateJobStatus(uid, status, filterReason = null) {
    this._db.prepare(`
      UPDATE upwork_jobs
      SET status = ?, filter_reason = ?, updated_at = datetime('now')
      WHERE uid = ?
    `).run(status, filterReason, uid);
  }
}

module.exports = UpworkDB;
