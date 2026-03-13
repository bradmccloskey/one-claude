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
        ('poll_enabled', '1'),
        ('auto_apply_enabled', '0'),
        ('auto_apply_threshold', '90'),
        ('auto_apply_max_daily', '3'),
        ('auto_apply_start_hour', '8'),
        ('auto_apply_end_hour', '22'),
        ('auto_apply_connects_floor', '15'),
        ('notify_high_match', '1'),
        ('notify_high_match_threshold', '80'),
        ('min_fixed_budget', '200');
    `);

    // Phase 2 migrations — ALTER TABLE has no IF NOT EXISTS, so use try/catch
    try { this._db.exec('ALTER TABLE upwork_jobs ADD COLUMN match_score INTEGER'); } catch {}
    try { this._db.exec('ALTER TABLE upwork_jobs ADD COLUMN screening_questions TEXT'); } catch {}
    try { this._db.exec('ALTER TABLE upwork_proposals ADD COLUMN screening_answers TEXT'); } catch {}

    // Phase 3 migration — detail scraping tracking
    try { this._db.exec('ALTER TABLE upwork_jobs ADD COLUMN detail_scraped_at TEXT'); } catch {}

    // Performance indexes for common query patterns
    try { this._db.exec('CREATE INDEX IF NOT EXISTS idx_upwork_jobs_match_score ON upwork_jobs(match_score DESC)'); } catch {}
    try { this._db.exec('CREATE INDEX IF NOT EXISTS idx_upwork_jobs_status_score ON upwork_jobs(status, match_score DESC)'); } catch {}

    // Application log table (DASH-02)
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS upwork_applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES upwork_jobs(id),
        proposal_text TEXT NOT NULL,
        screening_answers TEXT,
        connects_spent INTEGER,
        submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
        outcome TEXT DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_upwork_apps_job_id ON upwork_applications(job_id);
      CREATE INDEX IF NOT EXISTS idx_upwork_apps_submitted_at ON upwork_applications(submitted_at);
    `);

    // UNIQUE index on proposals for upsert pattern
    try { this._db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_upwork_proposals_job_id ON upwork_proposals(job_id)'); } catch {}
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

  /**
   * Get pending jobs with optional proposal data.
   * Returns jobs with status 'new' or 'proposal_ready', ordered by match score.
   * @param {number} [limit=50]
   * @returns {Object[]}
   */
  getPendingJobs(limit = 50) {
    return this._db.prepare(`
      SELECT j.*, p.cover_letter, p.screening_answers AS proposal_screening_answers
      FROM upwork_jobs j
      LEFT JOIN upwork_proposals p ON p.job_id = j.id
      WHERE j.status IN ('new', 'proposal_ready')
      ORDER BY j.match_score DESC, j.found_at DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * Upsert a proposal for a job. Uses ON CONFLICT to update existing.
   * @param {number} jobId
   * @param {string} coverLetter
   * @param {string|null} [screeningAnswers=null]
   * @returns {number} proposal id
   */
  upsertProposal(jobId, coverLetter, screeningAnswers = null) {
    const result = this._db.prepare(`
      INSERT INTO upwork_proposals (job_id, cover_letter, screening_answers)
      VALUES (?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        cover_letter = excluded.cover_letter,
        screening_answers = excluded.screening_answers
    `).run(jobId, coverLetter, screeningAnswers);
    return result.lastInsertRowid;
  }

  /**
   * Update a job's match score.
   * @param {string} uid
   * @param {number} score - 0-100
   */
  updateJobMatchScore(uid, score) {
    this._db.prepare(
      'UPDATE upwork_jobs SET match_score = ?, updated_at = datetime(\'now\') WHERE uid = ?'
    ).run(score, uid);
  }

  /**
   * Update job detail fields from detail-page scraping.
   * @param {string} uid
   * @param {Object} detail
   * @param {number} detail.clientPaymentVerified
   * @param {number|null} detail.clientRating
   * @param {string|null} detail.clientTotalSpent
   * @param {string|null} detail.screeningQuestions
   * @param {string|null} detail.description - Full description from detail page
   * @param {string|null} detail.skills - JSON array of skill strings
   * @param {string|null} detail.jobType - 'hourly', 'fixed', or null
   * @param {string|null} detail.proposalsCount - e.g. "15 to 20"
   * @param {number|null} detail.budget - Parsed budget amount
   * @param {number|null} detail.rateMin - Parsed hourly rate min
   * @param {number|null} detail.rateMax - Parsed hourly rate max
   */
  updateJobDetail(uid, detail) {
    this._db.prepare(`
      UPDATE upwork_jobs SET
        client_payment_verified = ?,
        client_rating = ?,
        client_total_spent = ?,
        screening_questions = ?,
        description = COALESCE(?, description),
        skills = CASE WHEN ? IS NOT NULL AND ? != '[]' THEN ? ELSE skills END,
        job_type = CASE WHEN ? IS NOT NULL THEN ? ELSE job_type END,
        proposals_count = COALESCE(?, proposals_count),
        budget = CASE WHEN ? IS NOT NULL THEN ? ELSE budget END,
        rate_min = CASE WHEN ? IS NOT NULL THEN ? ELSE rate_min END,
        rate_max = CASE WHEN ? IS NOT NULL THEN ? ELSE rate_max END,
        detail_scraped_at = datetime('now'),
        updated_at = datetime('now')
      WHERE uid = ?
    `).run(
      detail.clientPaymentVerified ?? 0,
      detail.clientRating ?? null,
      detail.clientTotalSpent ?? null,
      detail.screeningQuestions ?? null,
      detail.description ?? null,
      detail.skills ?? null, detail.skills ?? null, detail.skills ?? null,
      detail.jobType ?? null, detail.jobType ?? null,
      detail.proposalsCount ?? null,
      detail.budget ?? null, detail.budget ?? null,
      detail.rateMin ?? null, detail.rateMin ?? null,
      detail.rateMax ?? null, detail.rateMax ?? null,
      uid
    );
  }

  /**
   * Store the current connects balance in settings.
   * @param {number} balance
   */
  updateConnectsBalance(balance) {
    const now = new Date().toISOString();
    this._db.prepare(
      'INSERT OR REPLACE INTO upwork_settings (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('connects_balance', String(balance), now);
    this._db.prepare(
      'INSERT OR REPLACE INTO upwork_settings (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('connects_last_checked', now, now);
  }

  /**
   * Get the cached connects balance.
   * @returns {{ balance: number|null, lastChecked: string|null }}
   */
  getConnectsBalance() {
    const balRow = this._db.prepare(
      "SELECT value FROM upwork_settings WHERE key = 'connects_balance'"
    ).get();
    const checkedRow = this._db.prepare(
      "SELECT value FROM upwork_settings WHERE key = 'connects_last_checked'"
    ).get();
    return {
      balance: balRow ? parseInt(balRow.value, 10) : null,
      lastChecked: checkedRow ? checkedRow.value : null,
    };
  }

  /**
   * Get a single job by its Upwork UID.
   * @param {string} uid
   * @returns {Object|undefined}
   */
  getJobByUid(uid) {
    return this._db.prepare('SELECT * FROM upwork_jobs WHERE uid = ?').get(uid);
  }

  /**
   * Get jobs that haven't had their detail page scraped yet.
   * @param {number} [limit=10]
   * @returns {Object[]}
   */
  getJobsNeedingDetail(limit = 10) {
    return this._db.prepare(`
      SELECT * FROM upwork_jobs
      WHERE status IN ('new', 'proposal_ready') AND detail_scraped_at IS NULL
      ORDER BY found_at DESC
      LIMIT ?
    `).all(limit);
  }
  /**
   * Log a submitted application.
   * @param {number} jobId - upwork_jobs.id
   * @param {string} proposalText - The cover letter that was submitted
   * @param {string|null} screeningAnswers - Screening Q/A text
   * @param {number|null} connectsSpent - Connects consumed by this application
   * @returns {number} The new application row ID
   */
  insertApplication(jobId, proposalText, screeningAnswers, connectsSpent) {
    const result = this._db.prepare(`
      INSERT INTO upwork_applications (job_id, proposal_text, screening_answers, connects_spent)
      VALUES (?, ?, ?, ?)
    `).run(jobId, proposalText, screeningAnswers || null, connectsSpent || null);
    return Number(result.lastInsertRowid);
  }

  /**
   * Get a job by UID with its proposal data joined.
   * @param {string} uid
   * @returns {Object|undefined}
   */
  getJobWithProposal(uid) {
    return this._db.prepare(`
      SELECT j.*, p.cover_letter, p.screening_answers AS proposal_screening_answers
      FROM upwork_jobs j
      LEFT JOIN upwork_proposals p ON p.job_id = j.id
      WHERE j.uid = ?
    `).get(uid);
  }

  /**
   * Get applied jobs with outcome data for the dashboard.
   * @param {number} [limit=50]
   * @returns {Object[]}
   */
  getAppliedJobs(limit = 50) {
    return this._db.prepare(`
      SELECT j.*, a.outcome, a.connects_spent, a.submitted_at AS applied_at
      FROM upwork_jobs j
      LEFT JOIN upwork_applications a ON a.job_id = j.id
      WHERE j.status = 'applied'
      ORDER BY a.submitted_at DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * Update the outcome of an applied job.
   * @param {string} uid - Job UID
   * @param {string} outcome - One of: pending, got_response, interview, hired, no_response
   */
  updateApplicationOutcome(uid, outcome) {
    const job = this.getJobByUid(uid);
    if (!job) return;
    this._db.prepare(
      'UPDATE upwork_applications SET outcome = ? WHERE job_id = ?'
    ).run(outcome, job.id);
  }

  /**
   * Count auto-applied jobs today (for daily rate limiting).
   * @returns {number}
   */
  getAutoApplyCountToday() {
    const row = this._db.prepare(`
      SELECT COUNT(*) as cnt FROM upwork_applications
      WHERE submitted_at >= date('now')
        AND job_id IN (
          SELECT id FROM upwork_jobs WHERE filter_reason = 'auto_applied'
        )
    `).get();
    return row ? row.cnt : 0;
  }

  /**
   * Get auto-apply settings as a structured object.
   * @returns {{ enabled: boolean, threshold: number, maxDaily: number, startHour: number, endHour: number, connectsFloor: number, notifyHighMatch: boolean, notifyThreshold: number }}
   */
  getAutoApplySettings() {
    const s = this.getSettings();
    return {
      enabled: s.auto_apply_enabled === '1',
      threshold: parseInt(s.auto_apply_threshold || '90', 10),
      maxDaily: parseInt(s.auto_apply_max_daily || '3', 10),
      startHour: parseInt(s.auto_apply_start_hour || '8', 10),
      endHour: parseInt(s.auto_apply_end_hour || '22', 10),
      connectsFloor: parseInt(s.auto_apply_connects_floor || '15', 10),
      notifyHighMatch: s.notify_high_match !== '0',
      notifyThreshold: parseInt(s.notify_high_match_threshold || '80', 10),
      minFixedBudget: parseInt(s.min_fixed_budget || '0', 10),
    };
  }

  /**
   * Get pipeline statistics for analytics.
   * @returns {{ totalScanned: number, totalFiltered: number, totalPending: number, totalApplied: number, totalDismissed: number, responseRate: number, outcomes: Object, avgMatchScore: number, topFilterReasons: Object[] }}
   */
  getPipelineStats() {
    const total = this._db.prepare('SELECT COUNT(*) as cnt FROM upwork_jobs').get();
    const filtered = this._db.prepare("SELECT COUNT(*) as cnt FROM upwork_jobs WHERE status = 'filtered'").get();
    const pending = this._db.prepare("SELECT COUNT(*) as cnt FROM upwork_jobs WHERE status IN ('new', 'proposal_ready')").get();
    const applied = this._db.prepare("SELECT COUNT(*) as cnt FROM upwork_jobs WHERE status = 'applied'").get();
    const dismissed = this._db.prepare("SELECT COUNT(*) as cnt FROM upwork_jobs WHERE status = 'dismissed'").get();

    const outcomes = this._db.prepare(`
      SELECT outcome, COUNT(*) as cnt FROM upwork_applications GROUP BY outcome
    `).all().reduce((acc, r) => { acc[r.outcome] = r.cnt; return acc; }, {});

    const responded = (outcomes.got_response || 0) + (outcomes.interview || 0) + (outcomes.hired || 0);
    const totalOutcomes = applied.cnt || 1;
    const responseRate = Math.round((responded / totalOutcomes) * 100);

    const avgScore = this._db.prepare(
      'SELECT AVG(match_score) as avg FROM upwork_jobs WHERE match_score IS NOT NULL'
    ).get();

    const filterReasons = this._db.prepare(`
      SELECT filter_reason, COUNT(*) as cnt FROM upwork_jobs
      WHERE filter_reason IS NOT NULL
      GROUP BY filter_reason ORDER BY cnt DESC LIMIT 10
    `).all();

    const todayApplied = this._db.prepare(
      "SELECT COUNT(*) as cnt FROM upwork_applications WHERE submitted_at >= date('now')"
    ).get();

    const connectsSpent = this._db.prepare(
      'SELECT SUM(connects_spent) as total FROM upwork_applications'
    ).get();

    return {
      totalScanned: total.cnt,
      totalFiltered: filtered.cnt,
      totalPending: pending.cnt,
      totalApplied: applied.cnt,
      totalDismissed: dismissed.cnt,
      todayApplied: todayApplied.cnt,
      responseRate,
      outcomes,
      avgMatchScore: Math.round(avgScore.avg || 0),
      totalConnectsSpent: connectsSpent.total || 0,
      topFilterReasons: filterReasons,
    };
  }

  /**
   * Update a single setting.
   * @param {string} key
   * @param {string} value
   */
  updateSetting(key, value) {
    this._db.prepare(
      "INSERT OR REPLACE INTO upwork_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).run(key, String(value));
  }
}

module.exports = UpworkDB;
