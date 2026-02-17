'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Create a RevenueTracker with a temp DB for test isolation.
 * Overrides _ensureDb to use a temp directory instead of orchestrator.db.
 */
function createTestTracker(configOverrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const config = {
    revenue: {
      xmrWallet: 'test-wallet',
      retentionDays: 90,
      ...configOverrides,
    },
  };
  const RT = require('../lib/revenue-tracker');
  const tracker = new RT({ config });

  // Override DB path for test isolation
  tracker._ensureDb = function () {
    if (this.db) return;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS revenue_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        balance_atomic INTEGER,
        paid_atomic INTEGER,
        hashrate REAL,
        xmr_price_usd REAL,
        requests_served INTEGER,
        tokens_generated INTEGER,
        raw_json TEXT
      )
    `);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_revenue_source_time ON revenue_snapshots(source, collected_at)`
    );
  };

  return {
    tracker,
    tmpDir,
    dbPath,
    cleanup: () => {
      tracker.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('RevenueTracker', () => {
  describe('schema', () => {
    it('creates revenue_snapshots table on first access', () => {
      const { tracker, cleanup, dbPath } = createTestTracker();
      try {
        tracker._ensureDb();
        const tables = tracker.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revenue_snapshots'")
          .all();
        assert.equal(tables.length, 1);
        assert.equal(tables[0].name, 'revenue_snapshots');
      } finally {
        cleanup();
      }
    });

    it('creates index on source + collected_at', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        const indexes = tracker.db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_revenue_source_time'")
          .all();
        assert.equal(indexes.length, 1);
      } finally {
        cleanup();
      }
    });
  });

  describe('snapshot storage', () => {
    it('stores XMR snapshot with all fields populated', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        const now = new Date().toISOString();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic, paid_atomic, hashrate, xmr_price_usd)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run('xmr-mining', now, 629305994, 100000000, 2592, 330.0);

        const latest = tracker.getLatest();
        assert.equal(latest['xmr-mining'].balance_atomic, 629305994);
        assert.equal(latest['xmr-mining'].paid_atomic, 100000000);
        assert.equal(latest['xmr-mining'].hashrate, 2592);
        assert.equal(latest['xmr-mining'].xmr_price_usd, 330.0);
      } finally {
        cleanup();
      }
    });

    it('stores MLX snapshot with requests and tokens', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        const now = new Date().toISOString();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, requests_served, tokens_generated)
             VALUES (?, ?, ?, ?)`
          )
          .run('mlx-api', now, 1500, 250000);

        const latest = tracker.getLatest();
        assert.equal(latest['mlx-api'].requests_served, 1500);
        assert.equal(latest['mlx-api'].tokens_generated, 250000);
      } finally {
        cleanup();
      }
    });

    it('stores NULL fields when data is unavailable (not zero)', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic, paid_atomic, hashrate, xmr_price_usd)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run('xmr-mining', new Date().toISOString(), null, null, null, null);

        const latest = tracker.getLatest();
        assert.equal(latest['xmr-mining'].balance_atomic, null);
        assert.equal(latest['xmr-mining'].paid_atomic, null);
        assert.equal(latest['xmr-mining'].hashrate, null);
        assert.equal(latest['xmr-mining'].xmr_price_usd, null);
      } finally {
        cleanup();
      }
    });

    it('stores zero fields when data is genuinely zero', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic, paid_atomic, hashrate)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run('xmr-mining', new Date().toISOString(), 0, 0, 0);

        const latest = tracker.getLatest();
        assert.equal(latest['xmr-mining'].balance_atomic, 0);
        assert.equal(latest['xmr-mining'].paid_atomic, 0);
        assert.equal(latest['xmr-mining'].hashrate, 0);
      } finally {
        cleanup();
      }
    });

    it('NULL and zero are distinguishable in queries', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        const now = new Date().toISOString();

        // Insert a zero row
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic)
             VALUES (?, ?, ?)`
          )
          .run('xmr-mining', now, 0);

        const latest = tracker.getLatest();
        assert.equal(latest['xmr-mining'].balance_atomic, 0);
        assert.notEqual(latest['xmr-mining'].balance_atomic, null);

        // Verify strict equality: 0 !== null
        assert.ok(latest['xmr-mining'].balance_atomic === 0);
        assert.ok(latest['xmr-mining'].balance_atomic !== null);
      } finally {
        cleanup();
      }
    });
  });

  describe('getLatest', () => {
    it('returns null for source with no snapshots', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        const latest = tracker.getLatest();
        assert.equal(latest['xmr-mining'], null);
        assert.equal(latest['mlx-api'], null);
      } finally {
        cleanup();
      }
    });

    it('returns most recent snapshot per source', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        const older = '2026-02-16T10:00:00.000Z';
        const newer = '2026-02-17T10:00:00.000Z';

        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic)
             VALUES (?, ?, ?)`
          )
          .run('xmr-mining', older, 100);
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic)
             VALUES (?, ?, ?)`
          )
          .run('xmr-mining', newer, 200);

        const latest = tracker.getLatest();
        assert.equal(latest['xmr-mining'].balance_atomic, 200);
      } finally {
        cleanup();
      }
    });

    it('includes ageMinutes based on collected_at', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        // Insert a snapshot 30 minutes ago
        const thirtyMinAgo = new Date(Date.now() - 30 * 60000).toISOString();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic)
             VALUES (?, ?, ?)`
          )
          .run('xmr-mining', thirtyMinAgo, 500);

        const latest = tracker.getLatest();
        // Allow 1 minute tolerance for test execution time
        assert.ok(latest['xmr-mining'].ageMinutes >= 29, `ageMinutes should be >= 29, got ${latest['xmr-mining'].ageMinutes}`);
        assert.ok(latest['xmr-mining'].ageMinutes <= 32, `ageMinutes should be <= 32, got ${latest['xmr-mining'].ageMinutes}`);
      } finally {
        cleanup();
      }
    });
  });

  describe('formatForContext', () => {
    it('returns null when no data exists', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        const result = tracker.formatForContext();
        assert.equal(result, null);
      } finally {
        cleanup();
      }
    });

    it('includes XMR balance in USD with data age', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic, paid_atomic, hashrate, xmr_price_usd)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run('xmr-mining', new Date().toISOString(), 629305994, 0, 2592, 330.0);

        const result = tracker.formatForContext();
        assert.ok(result.includes('Revenue:'));
        assert.ok(result.includes('XMR Mining'));
        assert.ok(result.includes('$'));
        assert.ok(result.includes('H/s'));
      } finally {
        cleanup();
      }
    });

    it('includes MLX request count with data age', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, requests_served, tokens_generated)
             VALUES (?, ?, ?, ?)`
          )
          .run('mlx-api', new Date().toISOString(), 1500, 250000);

        const result = tracker.formatForContext();
        assert.ok(result.includes('MLX API'));
        assert.ok(result.includes('1500'));
        assert.ok(result.includes('250000'));
      } finally {
        cleanup();
      }
    });

    it('shows data unavailable for NULL snapshots', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic)
             VALUES (?, ?, ?)`
          )
          .run('xmr-mining', new Date().toISOString(), null);

        const result = tracker.formatForContext();
        assert.ok(result.includes('data unavailable'));
      } finally {
        cleanup();
      }
    });

    it('shows stale warning for old data', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        // Insert data from 3 hours ago
        const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic, xmr_price_usd)
             VALUES (?, ?, ?, ?)`
          )
          .run('xmr-mining', threeHoursAgo, 629305994, 330.0);

        const result = tracker.formatForContext();
        assert.ok(result.includes('STALE'));
      } finally {
        cleanup();
      }
    });
  });

  describe('getWeeklyTrend', () => {
    it('returns null for weeks with no data', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        const trend = tracker.getWeeklyTrend();
        assert.equal(trend.thisWeek.xmr, null);
        assert.equal(trend.thisWeek.mlx, null);
        assert.equal(trend.lastWeek.xmr, null);
        assert.equal(trend.lastWeek.mlx, null);
      } finally {
        cleanup();
      }
    });

    it('calculates XMR balance change over the week', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        const now = new Date();
        // Get start of this week (Sunday)
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        weekStart.setHours(1, 0, 0, 0);

        const early = weekStart.toISOString();
        const late = new Date(weekStart.getTime() + 86400000).toISOString(); // 1 day later

        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic, paid_atomic, xmr_price_usd)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run('xmr-mining', early, 500000000000, 0, 300.0);
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic, paid_atomic, xmr_price_usd)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run('xmr-mining', late, 600000000000, 0, 310.0);

        const trend = tracker.getWeeklyTrend();
        assert.ok(trend.thisWeek.xmr !== null, 'thisWeek.xmr should not be null');
        // Change = (600B - 500B) + paid_latest(0) = 100B atomic = 0.0001 XMR
        assert.ok(trend.thisWeek.xmr.changeXMR > 0, 'changeXMR should be positive');
      } finally {
        cleanup();
      }
    });

    it('calculates MLX request delta over the week', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        const now = new Date();
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        weekStart.setHours(1, 0, 0, 0);

        const early = weekStart.toISOString();
        const late = new Date(weekStart.getTime() + 86400000).toISOString();

        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, requests_served)
             VALUES (?, ?, ?)`
          )
          .run('mlx-api', early, 100);
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, requests_served)
             VALUES (?, ?, ?)`
          )
          .run('mlx-api', late, 250);

        const trend = tracker.getWeeklyTrend();
        assert.ok(trend.thisWeek.mlx !== null, 'thisWeek.mlx should not be null');
        assert.equal(trend.thisWeek.mlx.requests, 150);
      } finally {
        cleanup();
      }
    });
  });

  describe('_maybePrune', () => {
    it('deletes snapshots older than retention period', () => {
      const { tracker, cleanup } = createTestTracker({ retentionDays: 1 });
      try {
        tracker._ensureDb();
        // Reset prune time so it runs
        tracker._lastPruneTime = 0;

        // Insert old snapshot (2 days ago)
        const oldDate = new Date(Date.now() - 2 * 86400000).toISOString();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic)
             VALUES (?, ?, ?)`
          )
          .run('xmr-mining', oldDate, 100);

        // Insert recent snapshot
        const recentDate = new Date().toISOString();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic)
             VALUES (?, ?, ?)`
          )
          .run('xmr-mining', recentDate, 200);

        tracker._maybePrune();

        const rows = tracker.db.prepare('SELECT * FROM revenue_snapshots').all();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].balance_atomic, 200);
      } finally {
        cleanup();
      }
    });

    it('keeps snapshots within retention period', () => {
      const { tracker, cleanup } = createTestTracker({ retentionDays: 90 });
      try {
        tracker._ensureDb();
        tracker._lastPruneTime = 0;

        const recentDate = new Date().toISOString();
        tracker.db
          .prepare(
            `INSERT INTO revenue_snapshots (source, collected_at, balance_atomic)
             VALUES (?, ?, ?)`
          )
          .run('xmr-mining', recentDate, 500);

        tracker._maybePrune();

        const rows = tracker.db.prepare('SELECT * FROM revenue_snapshots').all();
        assert.equal(rows.length, 1);
      } finally {
        cleanup();
      }
    });
  });

  describe('close', () => {
    it('closes the database connection', () => {
      const { tracker, tmpDir } = createTestTracker();
      try {
        tracker._ensureDb();
        assert.ok(tracker.db !== null);
        tracker.close();
        assert.equal(tracker.db, null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('is safe to call multiple times', () => {
      const { tracker, tmpDir } = createTestTracker();
      try {
        tracker._ensureDb();
        tracker.close();
        tracker.close(); // Should not throw
        assert.equal(tracker.db, null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
