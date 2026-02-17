'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Create a TrustTracker with a temp DB for test isolation.
 * Overrides _ensureDb to use a temp directory instead of orchestrator.db.
 */
function createTestTracker(configOverrides = {}, stateOverrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const defaultState = {
    executionHistory: [],
    evaluationHistory: [],
    runtimeAutonomyLevel: 'cautious',
  };
  const stateData = { ...defaultState, ...stateOverrides };

  const mockState = {
    load: () => stateData,
    getAutonomyLevel: (s, c) =>
      s.runtimeAutonomyLevel || c.ai?.autonomyLevel || 'observe',
  };

  const config = {
    ai: { autonomyLevel: 'observe' },
    trust: {
      enabled: true,
      thresholds: {
        cautious_to_moderate: {
          minSessions: 30,
          minAvgScore: 3.5,
          minDaysAtLevel: 7,
        },
        moderate_to_full: {
          minSessions: 50,
          minAvgScore: 4.0,
          minDaysAtLevel: 14,
        },
      },
      ...configOverrides,
    },
  };

  const TT = require('../lib/trust-tracker');
  const tracker = new TT({ config, state: mockState });

  // Override DB path for test isolation
  tracker._ensureDb = function () {
    if (this.db) return;
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
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO trust_summary (autonomy_level) VALUES (?)'
    );
    for (const level of ['observe', 'cautious', 'moderate', 'full']) {
      insert.run(level);
    }
  };

  return {
    tracker,
    tmpDir,
    mockState,
    stateData,
    cleanup: () => {
      tracker.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('TrustTracker', () => {
  describe('schema', () => {
    it('creates trust_summary table with 4 rows on first access', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        const rows = tracker.db
          .prepare('SELECT COUNT(*) as count FROM trust_summary')
          .get();
        assert.equal(rows.count, 4);
      } finally {
        cleanup();
      }
    });

    it('seeds all four autonomy levels', () => {
      const { tracker, cleanup } = createTestTracker();
      try {
        tracker._ensureDb();
        const levels = tracker.db
          .prepare('SELECT autonomy_level FROM trust_summary ORDER BY autonomy_level')
          .all()
          .map((r) => r.autonomy_level);
        assert.deepEqual(levels, ['cautious', 'full', 'moderate', 'observe']);
      } finally {
        cleanup();
      }
    });
  });

  describe('update', () => {
    it('increments total_sessions for new start executions', () => {
      const { tracker, cleanup, stateData } = createTestTracker(
        {},
        {
          runtimeAutonomyLevel: 'cautious',
          executionHistory: [
            { action: 'start', timestamp: new Date().toISOString(), project: 'test-1' },
            { action: 'start', timestamp: new Date().toISOString(), project: 'test-2' },
            { action: 'stop', timestamp: new Date().toISOString(), project: 'test-1' },
          ],
          evaluationHistory: [],
        }
      );
      try {
        tracker.update();
        const row = tracker.db
          .prepare("SELECT * FROM trust_summary WHERE autonomy_level = 'cautious'")
          .get();
        assert.equal(row.total_sessions, 2); // Only 'start' actions count
      } finally {
        cleanup();
      }
    });

    it('accumulates evaluation scores', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        {
          runtimeAutonomyLevel: 'cautious',
          executionHistory: [],
          evaluationHistory: [
            { score: 4.0, evaluatedAt: new Date().toISOString() },
            { score: 3.5, evaluatedAt: new Date().toISOString() },
          ],
        }
      );
      try {
        tracker.update();
        const row = tracker.db
          .prepare("SELECT * FROM trust_summary WHERE autonomy_level = 'cautious'")
          .get();
        assert.equal(row.total_evaluations, 2);
        assert.equal(row.sum_eval_scores, 7.5);
      } finally {
        cleanup();
      }
    });

    it('only counts new entries since last update', () => {
      const { tracker, cleanup, stateData } = createTestTracker(
        {},
        {
          runtimeAutonomyLevel: 'cautious',
          executionHistory: [
            { action: 'start', timestamp: new Date().toISOString(), project: 'test-1' },
          ],
          evaluationHistory: [{ score: 4.0, evaluatedAt: new Date().toISOString() }],
        }
      );
      try {
        // First update
        tracker.update();
        let row = tracker.db
          .prepare("SELECT * FROM trust_summary WHERE autonomy_level = 'cautious'")
          .get();
        assert.equal(row.total_sessions, 1);
        assert.equal(row.total_evaluations, 1);

        // Second update with same data -- should NOT add more
        tracker.update();
        row = tracker.db
          .prepare("SELECT * FROM trust_summary WHERE autonomy_level = 'cautious'")
          .get();
        assert.equal(row.total_sessions, 1);
        assert.equal(row.total_evaluations, 1);
      } finally {
        cleanup();
      }
    });

    it('handles empty execution and evaluation history', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        {
          runtimeAutonomyLevel: 'cautious',
          executionHistory: [],
          evaluationHistory: [],
        }
      );
      try {
        // Should not throw
        tracker.update();
        const row = tracker.db
          .prepare("SELECT * FROM trust_summary WHERE autonomy_level = 'cautious'")
          .get();
        assert.equal(row.total_sessions, 0);
        assert.equal(row.total_evaluations, 0);
      } finally {
        cleanup();
      }
    });
  });

  describe('checkPromotion', () => {
    it('returns null for observe level (never automated)', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        { runtimeAutonomyLevel: 'observe' }
      );
      try {
        const result = tracker.checkPromotion();
        assert.equal(result, null);
      } finally {
        cleanup();
      }
    });

    it('returns null for full level (no higher level)', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        { runtimeAutonomyLevel: 'full' }
      );
      try {
        const result = tracker.checkPromotion();
        assert.equal(result, null);
      } finally {
        cleanup();
      }
    });

    it('returns null when thresholds not met', () => {
      const { tracker, cleanup } = createTestTracker(
        {
          thresholds: {
            cautious_to_moderate: {
              minSessions: 100,
              minAvgScore: 4.5,
              minDaysAtLevel: 30,
            },
          },
        },
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        // Only 1 session, score 3.0 -- well below thresholds
        tracker.db
          .prepare(
            `UPDATE trust_summary
             SET total_sessions = 1, total_evaluations = 1, sum_eval_scores = 3.0,
                 last_entered_at = ?
             WHERE autonomy_level = 'cautious'`
          )
          .run(new Date().toISOString());

        const result = tracker.checkPromotion();
        assert.equal(result, null);
      } finally {
        cleanup();
      }
    });

    it('returns recommendation string when all thresholds met', () => {
      const { tracker, cleanup } = createTestTracker(
        {
          thresholds: {
            cautious_to_moderate: {
              minSessions: 2,
              minAvgScore: 3.0,
              minDaysAtLevel: 1,
            },
          },
        },
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        // Set last_entered_at 2 days ago so minDaysAtLevel=1 is met
        const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
        tracker.db
          .prepare(
            `UPDATE trust_summary
             SET total_sessions = 5, total_evaluations = 3, sum_eval_scores = 12.0,
                 last_entered_at = ?
             WHERE autonomy_level = 'cautious'`
          )
          .run(twoDaysAgo);

        const result = tracker.checkPromotion();
        assert.ok(result !== null, 'checkPromotion should return recommendation');
        assert.ok(result.includes('cautious'));
        assert.ok(result.includes('moderate'));
        assert.ok(result.includes('ai level moderate'));
      } finally {
        cleanup();
      }
    });

    it('includes session count and avg score in recommendation', () => {
      const { tracker, cleanup } = createTestTracker(
        {
          thresholds: {
            cautious_to_moderate: {
              minSessions: 1,
              minAvgScore: 1.0,
              minDaysAtLevel: 1,
            },
          },
        },
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
        tracker.db
          .prepare(
            `UPDATE trust_summary
             SET total_sessions = 10, total_evaluations = 5, sum_eval_scores = 20.0,
                 last_entered_at = ?
             WHERE autonomy_level = 'cautious'`
          )
          .run(twoDaysAgo);

        const result = tracker.checkPromotion();
        assert.ok(result !== null, 'checkPromotion should return recommendation');
        assert.ok(result.includes('10 sessions'));
        assert.ok(result.includes('4.0'));
      } finally {
        cleanup();
      }
    });

    it('returns null on second call (already sent)', () => {
      const { tracker, cleanup } = createTestTracker(
        {
          thresholds: {
            cautious_to_moderate: {
              minSessions: 1,
              minAvgScore: 1.0,
              minDaysAtLevel: 1,
            },
          },
        },
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
        tracker.db
          .prepare(
            `UPDATE trust_summary
             SET total_sessions = 5, total_evaluations = 1, sum_eval_scores = 4.0,
                 last_entered_at = ?
             WHERE autonomy_level = 'cautious'`
          )
          .run(twoDaysAgo);

        const first = tracker.checkPromotion();
        assert.ok(first !== null, 'first call should return recommendation');
        const second = tracker.checkPromotion();
        assert.equal(second, null);
      } finally {
        cleanup();
      }
    });

    it('returns recommendation again after resetPromotionFlag', () => {
      const { tracker, cleanup } = createTestTracker(
        {
          thresholds: {
            cautious_to_moderate: {
              minSessions: 1,
              minAvgScore: 1.0,
              minDaysAtLevel: 1,
            },
          },
        },
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
        tracker.db
          .prepare(
            `UPDATE trust_summary
             SET total_sessions = 5, total_evaluations = 1, sum_eval_scores = 4.0,
                 last_entered_at = ?
             WHERE autonomy_level = 'cautious'`
          )
          .run(twoDaysAgo);

        const first = tracker.checkPromotion();
        assert.ok(first !== null, 'first call should return recommendation');

        tracker.resetPromotionFlag();

        const again = tracker.checkPromotion();
        assert.ok(again !== null, 'should return recommendation again after reset');
      } finally {
        cleanup();
      }
    });
  });

  describe('safety - no self-promotion', () => {
    it('executable code does not contain setAutonomyLevel', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'lib', 'trust-tracker.js'),
        'utf-8'
      );
      // Strip single-line comments and multi-line comments before checking
      const codeOnly = src
        .replace(/\/\/.*$/gm, '')       // Remove single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
        .replace(/\*[^/]*$/gm, '');       // Remove JSDoc continuation lines
      assert.equal(
        codeOnly.includes('setAutonomyLevel'),
        false,
        'trust-tracker.js executable code must never call setAutonomyLevel'
      );
    });
  });

  describe('getMetrics', () => {
    it('returns current level with zero metrics when new', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        const metrics = tracker.getMetrics();
        assert.equal(metrics.level, 'cautious');
        assert.equal(metrics.sessions, 0);
        assert.equal(metrics.avgScore, 0);
      } finally {
        cleanup();
      }
    });

    it('returns accurate session count and avg score', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `UPDATE trust_summary
             SET total_sessions = 15, total_evaluations = 10, sum_eval_scores = 38.5,
                 last_entered_at = ?
             WHERE autonomy_level = 'cautious'`
          )
          .run(new Date().toISOString());

        const metrics = tracker.getMetrics();
        assert.equal(metrics.sessions, 15);
        assert.equal(metrics.evaluations, 10);
        assert.equal(metrics.avgScore, 3.85);
      } finally {
        cleanup();
      }
    });

    it('includes promotion progress with percentages', () => {
      const { tracker, cleanup } = createTestTracker(
        {
          thresholds: {
            cautious_to_moderate: {
              minSessions: 30,
              minAvgScore: 3.5,
              minDaysAtLevel: 7,
            },
          },
        },
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `UPDATE trust_summary
             SET total_sessions = 15, total_evaluations = 10, sum_eval_scores = 38.5,
                 last_entered_at = ?
             WHERE autonomy_level = 'cautious'`
          )
          .run(new Date().toISOString());

        const metrics = tracker.getMetrics();
        assert.ok(metrics.promotionProgress !== null);
        assert.equal(metrics.promotionProgress.nextLevel, 'moderate');
        assert.equal(metrics.promotionProgress.sessionPct, 50); // 15/30 = 50%
        assert.equal(metrics.promotionProgress.scoreMet, true); // 3.85 >= 3.5
      } finally {
        cleanup();
      }
    });

    it('returns null promotionProgress for full level', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        { runtimeAutonomyLevel: 'full' }
      );
      try {
        const metrics = tracker.getMetrics();
        assert.equal(metrics.promotionProgress, null);
      } finally {
        cleanup();
      }
    });
  });

  describe('formatForContext', () => {
    it('includes current level and days', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `UPDATE trust_summary SET last_entered_at = ? WHERE autonomy_level = 'cautious'`
          )
          .run(new Date().toISOString());

        const result = tracker.formatForContext();
        assert.ok(result.includes('cautious'));
        assert.ok(result.includes('days'));
      } finally {
        cleanup();
      }
    });

    it('includes session count', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `UPDATE trust_summary
             SET total_sessions = 25, last_entered_at = ?
             WHERE autonomy_level = 'cautious'`
          )
          .run(new Date().toISOString());

        const result = tracker.formatForContext();
        assert.ok(result.includes('25'));
      } finally {
        cleanup();
      }
    });

    it('includes avg eval score', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `UPDATE trust_summary
             SET total_evaluations = 5, sum_eval_scores = 20.0, last_entered_at = ?
             WHERE autonomy_level = 'cautious'`
          )
          .run(new Date().toISOString());

        const result = tracker.formatForContext();
        assert.ok(result.includes('4'));
        assert.ok(result.includes('/5.0'));
      } finally {
        cleanup();
      }
    });

    it('includes promotion progress when applicable', () => {
      const { tracker, cleanup } = createTestTracker(
        {
          thresholds: {
            cautious_to_moderate: {
              minSessions: 30,
              minAvgScore: 3.5,
              minDaysAtLevel: 7,
            },
          },
        },
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `UPDATE trust_summary
             SET total_sessions = 15, total_evaluations = 5, sum_eval_scores = 20.0,
                 last_entered_at = ?
             WHERE autonomy_level = 'cautious'`
          )
          .run(new Date().toISOString());

        const result = tracker.formatForContext();
        assert.ok(result.includes('Promotion'));
        assert.ok(result.includes('moderate'));
        assert.ok(result.includes('%'));
      } finally {
        cleanup();
      }
    });

    it('shows N/A for eval score with zero evaluations', () => {
      const { tracker, cleanup } = createTestTracker(
        {},
        { runtimeAutonomyLevel: 'cautious' }
      );
      try {
        tracker._ensureDb();
        tracker.db
          .prepare(
            `UPDATE trust_summary SET last_entered_at = ? WHERE autonomy_level = 'cautious'`
          )
          .run(new Date().toISOString());

        const result = tracker.formatForContext();
        assert.ok(result.includes('N/A'));
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
