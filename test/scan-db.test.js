'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

function createTestScanDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scandb-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const ScanDB = require('../lib/scan-db');
  const scanDb = new ScanDB();

  // Override DB path for test isolation
  scanDb._ensureDb = function () {
    if (this._db) return this._db;
    this._db = new Database(dbPath);
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
      CREATE INDEX IF NOT EXISTS idx_scans_project ON project_scans(project_name);
      CREATE INDEX IF NOT EXISTS idx_scans_time ON project_scans(scanned_at);
      CREATE INDEX IF NOT EXISTS idx_scans_project_time ON project_scans(project_name, scanned_at);
    `);
    return this._db;
  };

  const cleanup = () => {
    scanDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { scanDb, cleanup };
}

describe('ScanDB', () => {
  let scanDb, cleanup;

  afterEach(() => {
    if (cleanup) cleanup();
  });

  describe('insert', () => {
    it('inserts a single scan record', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      scanDb.insert({
        projectName: 'revenue/web-scraping-biz',
        gitBranch: 'main',
        lastCommitAt: '2026-03-01T10:00:00Z',
        lastCommitMessage: 'fix: update scraper',
        dirtyFiles: 2,
        gsdPhasesTotal: 5,
        gsdPhasesComplete: 3,
      });

      const result = scanDb.getLatest('revenue/web-scraping-biz');
      assert.ok(result);
      assert.equal(result.project_name, 'revenue/web-scraping-biz');
      assert.equal(result.git_branch, 'main');
      assert.equal(result.dirty_files, 2);
      assert.equal(result.gsd_phases_total, 5);
      assert.equal(result.gsd_phases_complete, 3);
    });

    it('handles null/missing optional fields', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      scanDb.insert({ projectName: 'apps/demo' });

      const result = scanDb.getLatest('apps/demo');
      assert.ok(result);
      assert.equal(result.git_branch, null);
      assert.equal(result.dirty_files, 0);
      assert.equal(result.gsd_phases_total, 0);
    });
  });

  describe('insertMany', () => {
    it('inserts multiple records in a transaction', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      scanDb.insertMany([
        { projectName: 'project-a', gitBranch: 'main', dirtyFiles: 1 },
        { projectName: 'project-b', gitBranch: 'dev', dirtyFiles: 0 },
        { projectName: 'project-c', gitBranch: 'main', dirtyFiles: 3 },
      ]);

      const all = scanDb.getLatestAll();
      assert.equal(all.length, 3);
    });

    it('handles empty array', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      scanDb.insertMany([]);
      const all = scanDb.getLatestAll();
      assert.equal(all.length, 0);
    });
  });

  describe('getLatestAll', () => {
    it('returns only the latest scan per project', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      const db = scanDb._ensureDb();

      // Insert two scans for same project with different timestamps
      db.prepare(`INSERT INTO project_scans (project_name, scanned_at, dirty_files) VALUES (?, ?, ?)`)
        .run('project-a', '2026-03-01T08:00:00', 5);
      db.prepare(`INSERT INTO project_scans (project_name, scanned_at, dirty_files) VALUES (?, ?, ?)`)
        .run('project-a', '2026-03-01T09:00:00', 2);
      db.prepare(`INSERT INTO project_scans (project_name, scanned_at, dirty_files) VALUES (?, ?, ?)`)
        .run('project-b', '2026-03-01T09:00:00', 0);

      const latest = scanDb.getLatestAll();
      assert.equal(latest.length, 2);
      const a = latest.find(r => r.project_name === 'project-a');
      assert.equal(a.dirty_files, 2); // latest scan
    });
  });

  describe('getLatest', () => {
    it('returns null for unknown project', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      const result = scanDb.getLatest('nonexistent');
      assert.equal(result, null);
    });
  });

  describe('getHistory', () => {
    it('returns scans in reverse chronological order', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      const db = scanDb._ensureDb();

      for (let i = 1; i <= 5; i++) {
        db.prepare(`INSERT INTO project_scans (project_name, scanned_at, dirty_files) VALUES (?, ?, ?)`)
          .run('project-a', `2026-03-01T0${i}:00:00`, i);
      }

      const history = scanDb.getHistory('project-a', 3);
      assert.equal(history.length, 3);
      assert.equal(history[0].dirty_files, 5); // most recent first
      assert.equal(history[2].dirty_files, 3);
    });

    it('defaults to 10 records', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      const db = scanDb._ensureDb();

      for (let i = 0; i < 15; i++) {
        db.prepare(`INSERT INTO project_scans (project_name, scanned_at) VALUES (?, ?)`)
          .run('project-a', `2026-03-01T${String(i).padStart(2, '0')}:00:00`);
      }

      const history = scanDb.getHistory('project-a');
      assert.equal(history.length, 10);
    });
  });

  describe('cleanup', () => {
    it('deletes scans older than retention period', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      const db = scanDb._ensureDb();

      // Insert old scan (10 days ago) and recent scan
      db.prepare(`INSERT INTO project_scans (project_name, scanned_at) VALUES (?, ?)`)
        .run('project-a', new Date(Date.now() - 10 * 86400000).toISOString());
      db.prepare(`INSERT INTO project_scans (project_name, scanned_at) VALUES (?, ?)`)
        .run('project-a', new Date().toISOString());

      const deleted = scanDb.cleanup();
      assert.equal(deleted, 1);

      const remaining = scanDb.getHistory('project-a');
      assert.equal(remaining.length, 1);
    });
  });

  describe('close', () => {
    it('closes the database connection', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      scanDb._ensureDb(); // force open
      scanDb.close();
      assert.equal(scanDb._db, null);
    });

    it('is safe to call multiple times', () => {
      ({ scanDb, cleanup } = createTestScanDb());
      scanDb.close();
      scanDb.close();
      assert.equal(scanDb._db, null);
    });
  });
});
