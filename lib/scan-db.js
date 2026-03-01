'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'orchestrator.db');
const RETENTION_DAYS = 7;

/**
 * ScanDB — Persists enriched project scan data (git + GSD) to SQLite.
 *
 * Uses the existing orchestrator.db. Lazy table creation on first use.
 * Provides insert, query, and cleanup methods.
 */
class ScanDB {
  constructor() {
    this._db = null;
  }

  _ensureDb() {
    if (this._db) return this._db;

    this._db = new Database(DB_PATH);
    this._db.pragma('journal_mode = WAL');

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS project_scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name TEXT NOT NULL,
        scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
        git_branch TEXT,
        last_commit_at TEXT,
        last_commit_message TEXT,
        dirty_files INTEGER DEFAULT 0,
        gsd_phases_total INTEGER DEFAULT 0,
        gsd_phases_complete INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_scans_project
        ON project_scans(project_name);
      CREATE INDEX IF NOT EXISTS idx_scans_time
        ON project_scans(scanned_at);
      CREATE INDEX IF NOT EXISTS idx_scans_project_time
        ON project_scans(project_name, scanned_at);
    `);

    return this._db;
  }

  /**
   * Insert a scan record for a project.
   * @param {Object} scan
   * @param {string} scan.projectName
   * @param {string|null} scan.gitBranch
   * @param {string|null} scan.lastCommitAt - ISO timestamp
   * @param {string|null} scan.lastCommitMessage
   * @param {number} scan.dirtyFiles
   * @param {number} scan.gsdPhasesTotal
   * @param {number} scan.gsdPhasesComplete
   */
  insert(scan) {
    const db = this._ensureDb();
    const stmt = db.prepare(`
      INSERT INTO project_scans
        (project_name, git_branch, last_commit_at, last_commit_message, dirty_files, gsd_phases_total, gsd_phases_complete)
      VALUES
        (@projectName, @gitBranch, @lastCommitAt, @lastCommitMessage, @dirtyFiles, @gsdPhasesTotal, @gsdPhasesComplete)
    `);
    stmt.run({
      projectName: scan.projectName,
      gitBranch: scan.gitBranch || null,
      lastCommitAt: scan.lastCommitAt || null,
      lastCommitMessage: scan.lastCommitMessage || null,
      dirtyFiles: scan.dirtyFiles || 0,
      gsdPhasesTotal: scan.gsdPhasesTotal || 0,
      gsdPhasesComplete: scan.gsdPhasesComplete || 0,
    });
  }

  /**
   * Insert multiple scans in a single transaction.
   * @param {Object[]} scans - Array of scan objects
   */
  insertMany(scans) {
    const db = this._ensureDb();
    const stmt = db.prepare(`
      INSERT INTO project_scans
        (project_name, git_branch, last_commit_at, last_commit_message, dirty_files, gsd_phases_total, gsd_phases_complete)
      VALUES
        (@projectName, @gitBranch, @lastCommitAt, @lastCommitMessage, @dirtyFiles, @gsdPhasesTotal, @gsdPhasesComplete)
    `);

    const insertAll = db.transaction((items) => {
      for (const scan of items) {
        stmt.run({
          projectName: scan.projectName,
          gitBranch: scan.gitBranch || null,
          lastCommitAt: scan.lastCommitAt || null,
          lastCommitMessage: scan.lastCommitMessage || null,
          dirtyFiles: scan.dirtyFiles || 0,
          gsdPhasesTotal: scan.gsdPhasesTotal || 0,
          gsdPhasesComplete: scan.gsdPhasesComplete || 0,
        });
      }
    });

    insertAll(scans);
  }

  /**
   * Get the latest scan for each project.
   * @returns {Object[]} Array of latest scan records
   */
  getLatestAll() {
    const db = this._ensureDb();
    return db.prepare(`
      SELECT s.* FROM project_scans s
      INNER JOIN (
        SELECT project_name, MAX(scanned_at) AS max_time
        FROM project_scans
        GROUP BY project_name
      ) latest ON s.project_name = latest.project_name AND s.scanned_at = latest.max_time
      ORDER BY s.project_name
    `).all();
  }

  /**
   * Get the latest scan for a single project.
   * @param {string} projectName
   * @returns {Object|null}
   */
  getLatest(projectName) {
    const db = this._ensureDb();
    return db.prepare(`
      SELECT * FROM project_scans
      WHERE project_name = ?
      ORDER BY scanned_at DESC
      LIMIT 1
    `).get(projectName) || null;
  }

  /**
   * Get scan history for a project (last N records).
   * @param {string} projectName
   * @param {number} [limit=10]
   * @returns {Object[]}
   */
  getHistory(projectName, limit = 10) {
    const db = this._ensureDb();
    return db.prepare(`
      SELECT * FROM project_scans
      WHERE project_name = ?
      ORDER BY scanned_at DESC
      LIMIT ?
    `).all(projectName, limit);
  }

  /**
   * Delete scans older than retention period.
   * @returns {number} Number of rows deleted
   */
  cleanup() {
    const db = this._ensureDb();
    const result = db.prepare(`
      DELETE FROM project_scans
      WHERE scanned_at < datetime('now', '-' || ? || ' days')
    `).run(RETENTION_DAYS);
    return result.changes;
  }

  /**
   * Close the database connection.
   */
  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

module.exports = ScanDB;
