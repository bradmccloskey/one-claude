'use strict';

const Database = require('better-sqlite3');
const path = require('path');

/**
 * SessionLearner - Persists session evaluation data in SQLite for pattern analysis.
 *
 * After enough evaluations accumulate (default 50), identifies which prompt styles,
 * session durations, and project approaches yield the best scores. Results are cached
 * and included in AI context to improve future session planning.
 *
 * Uses the shared orchestrator.db (same as RevenueTracker, TrustTracker, ReminderManager)
 * with lazy initialization.
 */
class SessionLearner {
  /**
   * @param {Object} deps
   * @param {Object} deps.config - Orchestrator config object
   */
  constructor({ config }) {
    this.config = config;
    this.db = null; // Lazy init
    this._cachedPatterns = null;
    this._evalCountAtLastAnalysis = 0;
  }

  /**
   * Lazy SQLite initialization. Creates session_evaluations table if not exists.
   */
  _ensureDb() {
    if (this.db) return;
    const dbPath = path.join(__dirname, '..', 'orchestrator.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        started_at TEXT,
        stopped_at TEXT,
        duration_minutes INTEGER,
        commit_count INTEGER DEFAULT 0,
        insertions INTEGER DEFAULT 0,
        deletions INTEGER DEFAULT 0,
        files_changed INTEGER DEFAULT 0,
        score INTEGER,
        recommendation TEXT,
        prompt_snippet TEXT,
        prompt_style TEXT,
        evaluated_at TEXT NOT NULL
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_session_eval_project ON session_evaluations(project_name)`
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_session_eval_score ON session_evaluations(score)`
    );
  }

  /**
   * Record a session evaluation into SQLite.
   * Classifies the prompt style and truncates prompt to 200 chars for the snippet.
   *
   * @param {Object} evaluation - Evaluation record from SessionEvaluator
   * @param {string} evaluation.sessionId - Session identifier
   * @param {string} evaluation.projectName - Project name
   * @param {string} evaluation.startedAt - ISO start timestamp
   * @param {string} evaluation.stoppedAt - ISO stop timestamp
   * @param {number} evaluation.durationMinutes - Session duration
   * @param {Object} evaluation.gitProgress - Git stats object
   * @param {number} evaluation.score - 1-5 score
   * @param {string} evaluation.recommendation - continue/retry/escalate/complete
   * @param {string} evaluation.prompt - Original session prompt
   * @param {string} evaluation.evaluatedAt - ISO evaluation timestamp
   */
  recordEvaluation(evaluation) {
    this._ensureDb();

    const prompt = evaluation.prompt || '';
    const snippet = prompt.length > 200 ? prompt.substring(0, 200) : prompt;
    const style = this._classifyPromptStyle(prompt);

    const git = evaluation.gitProgress || {};

    this.db.prepare(`
      INSERT INTO session_evaluations
        (session_id, project_name, started_at, stopped_at, duration_minutes,
         commit_count, insertions, deletions, files_changed,
         score, recommendation, prompt_snippet, prompt_style, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evaluation.sessionId || '',
      evaluation.projectName || '',
      evaluation.startedAt || null,
      evaluation.stoppedAt || null,
      evaluation.durationMinutes || 0,
      git.commitCount || 0,
      git.insertions || 0,
      git.deletions || 0,
      git.filesChanged || 0,
      evaluation.score || 0,
      evaluation.recommendation || '',
      snippet,
      style,
      evaluation.evaluatedAt || new Date().toISOString()
    );

    // Invalidate cache when analysis interval reached
    const analysisInterval = this.config.learning?.analysisInterval || 10;
    const totalCount = this.db.prepare('SELECT COUNT(*) as cnt FROM session_evaluations').get().cnt;
    if (totalCount - this._evalCountAtLastAnalysis >= analysisInterval) {
      this._cachedPatterns = null;
    }
  }

  /**
   * Classify prompt style based on keyword matching.
   *
   * @param {string} prompt - Session prompt text
   * @returns {string} Style classification: fix|implement|explore|resume|custom
   */
  _classifyPromptStyle(prompt) {
    if (!prompt) return 'custom';
    const lower = prompt.toLowerCase();

    if (/\b(fix|bug|error)\b/.test(lower)) return 'fix';
    if (/\b(implement|add|create|build)\b/.test(lower)) return 'implement';
    if (/\b(explore|read|understand|investigate)\b/.test(lower)) return 'explore';
    if (/\b(resume|continue|left off)\b/.test(lower)) return 'resume';
    return 'custom';
  }

  /**
   * Analyze evaluation patterns. Returns null below minEvaluations threshold.
   * Above threshold, runs SQL queries for pattern insights and caches results.
   *
   * @returns {Object|null} Pattern insights or null if insufficient data
   */
  analyzePatterns() {
    this._ensureDb();

    const minEvaluations = this.config.learning?.minEvaluations || 50;
    const totalCount = this.db.prepare('SELECT COUNT(*) as cnt FROM session_evaluations').get().cnt;

    if (totalCount < minEvaluations) return null;

    // Return cached if available
    if (this._cachedPatterns) return this._cachedPatterns;

    // Avg score by project (min 3 sessions)
    const byProject = this.db.prepare(`
      SELECT project_name, COUNT(*) as sessions, ROUND(AVG(score), 2) as avg_score
      FROM session_evaluations
      GROUP BY project_name
      HAVING sessions >= 3
      ORDER BY avg_score DESC
    `).all();

    // Avg score by prompt style (min 5 sessions)
    const byStyle = this.db.prepare(`
      SELECT prompt_style, COUNT(*) as sessions, ROUND(AVG(score), 2) as avg_score
      FROM session_evaluations
      GROUP BY prompt_style
      HAVING sessions >= 5
      ORDER BY avg_score DESC
    `).all();

    // Optimal duration range (sessions scoring 4+)
    const durationRange = this.db.prepare(`
      SELECT MIN(duration_minutes) as min_dur, MAX(duration_minutes) as max_dur,
             ROUND(AVG(duration_minutes), 0) as avg_dur
      FROM session_evaluations
      WHERE score >= 4
    `).get();

    // Time-of-day patterns in 4-hour blocks
    const byTimeOfDay = this.db.prepare(`
      SELECT
        CASE
          WHEN CAST(strftime('%H', started_at) AS INTEGER) BETWEEN 0 AND 3 THEN '00-04'
          WHEN CAST(strftime('%H', started_at) AS INTEGER) BETWEEN 4 AND 7 THEN '04-08'
          WHEN CAST(strftime('%H', started_at) AS INTEGER) BETWEEN 8 AND 11 THEN '08-12'
          WHEN CAST(strftime('%H', started_at) AS INTEGER) BETWEEN 12 AND 15 THEN '12-16'
          WHEN CAST(strftime('%H', started_at) AS INTEGER) BETWEEN 16 AND 19 THEN '16-20'
          ELSE '20-24'
        END as time_block,
        COUNT(*) as sessions,
        ROUND(AVG(score), 2) as avg_score
      FROM session_evaluations
      WHERE started_at IS NOT NULL
      GROUP BY time_block
      ORDER BY avg_score DESC
    `).all();

    this._cachedPatterns = {
      totalEvaluations: totalCount,
      byProject,
      byStyle,
      optimalDuration: durationRange,
      byTimeOfDay,
    };
    this._evalCountAtLastAnalysis = totalCount;

    return this._cachedPatterns;
  }

  /**
   * Format pattern insights for AI context inclusion.
   * Returns insufficient data message below threshold, or formatted insights above.
   *
   * @returns {string} Formatted pattern summary
   */
  formatForContext() {
    this._ensureDb();

    const minEvaluations = this.config.learning?.minEvaluations || 50;
    const totalCount = this.db.prepare('SELECT COUNT(*) as cnt FROM session_evaluations').get().cnt;

    if (totalCount < minEvaluations) {
      return `Session Learnings: Insufficient data (${totalCount}/${minEvaluations} evaluations)`;
    }

    const patterns = this.analyzePatterns();
    if (!patterns) {
      return `Session Learnings: Insufficient data (${totalCount}/${minEvaluations} evaluations)`;
    }

    const lines = [`Session Learnings (${patterns.totalEvaluations} evaluations):`];

    // Best projects
    if (patterns.byProject.length > 0) {
      const top3 = patterns.byProject.slice(0, 3);
      lines.push('  Best projects: ' + top3.map(p => `${p.project_name} (${p.avg_score}/5)`).join(', '));
    }

    // Best prompt styles
    if (patterns.byStyle.length > 0) {
      lines.push('  Best prompt styles: ' + patterns.byStyle.map(s => `${s.prompt_style} (${s.avg_score}/5)`).join(', '));
    }

    // Optimal duration
    if (patterns.optimalDuration && patterns.optimalDuration.avg_dur !== null) {
      lines.push(`  Optimal duration: ${patterns.optimalDuration.min_dur}-${patterns.optimalDuration.max_dur}min (avg ${patterns.optimalDuration.avg_dur}min for score 4+)`);
    }

    // Best time of day
    if (patterns.byTimeOfDay.length > 0) {
      const best = patterns.byTimeOfDay[0];
      lines.push(`  Best time block: ${best.time_block} (${best.avg_score}/5, ${best.sessions} sessions)`);
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

module.exports = SessionLearner;
