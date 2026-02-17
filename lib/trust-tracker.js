const Database = require('better-sqlite3');
const path = require('path');

/**
 * TrustTracker - Accumulates per-autonomy-level trust metrics from state data.
 * Tracks sessions launched, evaluation scores, and days at each level.
 * Checks promotion thresholds and returns recommendations (NEVER self-promotes).
 *
 * Uses the shared orchestrator.db (same as RevenueTracker) with lazy init.
 */
class TrustTracker {
  constructor({ config, state }) {
    this.config = config;
    this.state = state;
    this.db = null; // Lazy init (shared orchestrator.db)
    this._lastUpdateTime = 0;
    this._lastSessionCount = 0;
    this._lastEvalCount = 0;
    this._promotionSent = false; // Tracks if a promotion SMS was already sent at current level
  }

  /**
   * Lazy SQLite initialization. Uses the SAME orchestrator.db as RevenueTracker.
   * Creates trust_summary table with 4 rows (one per autonomy level) if not exists.
   */
  _ensureDb() {
    if (this.db) return;
    const dbPath = path.join(__dirname, '..', 'orchestrator.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trust_summary (
        autonomy_level TEXT PRIMARY KEY,
        total_sessions INTEGER DEFAULT 0,
        total_evaluations INTEGER DEFAULT 0,
        sum_eval_scores REAL DEFAULT 0,
        false_alerts INTEGER DEFAULT 0,
        true_alerts INTEGER DEFAULT 0,
        first_entered_at TEXT,
        last_entered_at TEXT,
        total_days REAL DEFAULT 0
      )
    `);

    // Seed rows for all 4 levels if they don't exist
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO trust_summary (autonomy_level) VALUES (?)'
    );
    for (const level of ['observe', 'cautious', 'moderate', 'full']) {
      insert.run(level);
    }
  }

  /**
   * Accumulate trust metrics from state's executionHistory and evaluationHistory.
   * Counts new session starts and evaluation scores since last update,
   * and writes them to the trust_summary row for the current autonomy level.
   */
  update() {
    this._ensureDb();
    const stateData = this.state.load();
    const currentLevel = this.state.getAutonomyLevel(stateData, this.config);

    // Ensure this level has an entered_at timestamp
    const row = this.db.prepare(
      'SELECT * FROM trust_summary WHERE autonomy_level = ?'
    ).get(currentLevel);

    if (!row.last_entered_at) {
      this.db.prepare(
        'UPDATE trust_summary SET first_entered_at = ?, last_entered_at = ? WHERE autonomy_level = ?'
      ).run(new Date().toISOString(), new Date().toISOString(), currentLevel);
    }

    // Count new sessions (action='start' in executionHistory)
    const execHistory = stateData.executionHistory || [];
    const currentSessionCount = execHistory.filter(e => e.action === 'start').length;
    const newSessions = Math.max(0, currentSessionCount - this._lastSessionCount);
    this._lastSessionCount = currentSessionCount;

    // Count new evaluations
    const evalHistory = stateData.evaluationHistory || [];
    const currentEvalCount = evalHistory.length;
    const newEvals = Math.max(0, currentEvalCount - this._lastEvalCount);
    this._lastEvalCount = currentEvalCount;

    if (newSessions > 0 || newEvals > 0) {
      // Sum scores of new evaluations
      const newEvalScores = evalHistory.slice(-newEvals).reduce(
        (sum, e) => sum + (e.score || 0), 0
      );

      this.db.prepare(`
        UPDATE trust_summary
        SET total_sessions = total_sessions + ?,
            total_evaluations = total_evaluations + ?,
            sum_eval_scores = sum_eval_scores + ?
        WHERE autonomy_level = ?
      `).run(newSessions, newEvals, newEvalScores, currentLevel);
    }

    this._lastUpdateTime = Date.now();
  }

  /**
   * Compare current level metrics against configurable thresholds.
   * Returns a promotion recommendation string or null.
   * NEVER calls state.setAutonomyLevel() -- recommendation only.
   *
   * - observe -> cautious: always returns null (policy decision, not automated)
   * - full: always returns null (no higher level)
   * - Already sent recommendation at this level: returns null
   */
  checkPromotion() {
    this._ensureDb();
    const stateData = this.state.load();
    const currentLevel = this.state.getAutonomyLevel(stateData, this.config);

    // observe -> cautious is a policy decision, not automated
    if (currentLevel === 'observe') return null;
    // full has no higher level
    if (currentLevel === 'full') return null;
    // Already sent a promotion recommendation at this level
    if (this._promotionSent) return null;

    const nextLevel = currentLevel === 'cautious' ? 'moderate' : 'full';
    const thresholdKey = `${currentLevel}_to_${nextLevel}`;
    const thresholds = this.config.trust?.thresholds?.[thresholdKey];
    if (!thresholds) return null;

    const row = this.db.prepare(
      'SELECT * FROM trust_summary WHERE autonomy_level = ?'
    ).get(currentLevel);

    if (!row) return null;

    const avgScore = row.total_evaluations > 0
      ? row.sum_eval_scores / row.total_evaluations
      : 0;

    const daysAtLevel = row.last_entered_at
      ? (Date.now() - new Date(row.last_entered_at).getTime()) / 86400000 + (row.total_days || 0)
      : 0;

    // Check all thresholds
    const meetsSession = row.total_sessions >= (thresholds.minSessions || 30);
    const meetsScore = avgScore >= (thresholds.minAvgScore || 3.5);
    const meetsDays = daysAtLevel >= (thresholds.minDaysAtLevel || 7);

    if (meetsSession && meetsScore && meetsDays) {
      this._promotionSent = true;
      return `Trust metrics suggest promotion from ${currentLevel} to ${nextLevel}. ` +
        `${row.total_sessions} sessions, avg score ${avgScore.toFixed(1)}/5, ` +
        `${Math.round(daysAtLevel)} days at level. ` +
        `Send \`ai level ${nextLevel}\` to approve.`;
    }

    return null;
  }

  /**
   * Reset the promotion sent flag. Called when autonomy level changes
   * so the new level can eventually trigger its own promotion check.
   */
  resetPromotionFlag() {
    this._promotionSent = false;
  }

  /**
   * Get current level stats for context and API.
   * Returns sessions, avg score, days at level, and promotion progress.
   */
  getMetrics() {
    this._ensureDb();
    const stateData = this.state.load();
    const currentLevel = this.state.getAutonomyLevel(stateData, this.config);

    const row = this.db.prepare(
      'SELECT * FROM trust_summary WHERE autonomy_level = ?'
    ).get(currentLevel);

    if (!row) return { level: currentLevel, sessions: 0, avgScore: 0, days: 0 };

    const avgScore = row.total_evaluations > 0
      ? row.sum_eval_scores / row.total_evaluations
      : 0;

    const daysAtLevel = row.last_entered_at
      ? (Date.now() - new Date(row.last_entered_at).getTime()) / 86400000 + (row.total_days || 0)
      : 0;

    // Calculate promotion progress
    const nextLevel = currentLevel === 'cautious' ? 'moderate'
      : currentLevel === 'moderate' ? 'full' : null;
    const thresholdKey = nextLevel ? `${currentLevel}_to_${nextLevel}` : null;
    const thresholds = thresholdKey ? this.config.trust?.thresholds?.[thresholdKey] : null;

    let promotionProgress = null;
    if (thresholds) {
      const sessionPct = Math.min(100, Math.round(
        row.total_sessions / (thresholds.minSessions || 30) * 100
      ));
      const scoreMet = avgScore >= (thresholds.minAvgScore || 3.5);
      const daysPct = Math.min(100, Math.round(
        daysAtLevel / (thresholds.minDaysAtLevel || 7) * 100
      ));
      promotionProgress = { sessionPct, scoreMet, daysPct, nextLevel };
    }

    return {
      level: currentLevel,
      sessions: row.total_sessions,
      evaluations: row.total_evaluations,
      avgScore: parseFloat(avgScore.toFixed(2)),
      days: parseFloat(daysAtLevel.toFixed(1)),
      promotionProgress,
    };
  }

  /**
   * Compact string for AI context showing trust metrics and promotion progress.
   * @returns {string} Multi-line trust metrics summary
   */
  formatForContext() {
    const metrics = this.getMetrics();
    const lines = ['Trust Metrics:'];
    lines.push(`- Current level: ${metrics.level} (${metrics.days} days)`);
    lines.push(`- Sessions at this level: ${metrics.sessions}`);

    if (metrics.evaluations > 0) {
      lines.push(`- Avg eval score: ${metrics.avgScore}/5.0 (${metrics.evaluations} evaluations)`);
    } else {
      lines.push('- Avg eval score: N/A (no evaluations yet)');
    }

    if (metrics.promotionProgress) {
      const p = metrics.promotionProgress;
      lines.push(`- Promotion to ${p.nextLevel}: sessions ${p.sessionPct}%, score ${p.scoreMet ? 'MET' : 'NOT MET'}, days ${p.daysPct}%`);
    }

    return lines.join('\n');
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

module.exports = TrustTracker;
