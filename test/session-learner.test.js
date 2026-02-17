'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Create a test evaluation object with sensible defaults.
 */
function makeEval(overrides = {}) {
  return {
    sessionId: 'orch-test-project',
    projectName: 'test-project',
    startedAt: '2026-02-17T10:00:00Z',
    stoppedAt: '2026-02-17T10:30:00Z',
    durationMinutes: 30,
    gitProgress: {
      commitCount: 3,
      insertions: 150,
      deletions: 20,
      filesChanged: 5,
    },
    score: 4,
    recommendation: 'continue',
    prompt: 'Implement the user authentication module',
    evaluatedAt: '2026-02-17T10:31:00Z',
    ...overrides,
  };
}

/**
 * Create a SessionLearner with a temp DB for test isolation.
 * Overrides _ensureDb to use a temp directory instead of orchestrator.db.
 */
function createTestLearner(configOverrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const config = {
    learning: {
      enabled: true,
      minEvaluations: 50,
      analysisInterval: 10,
      ...configOverrides,
    },
  };

  const SL = require('../lib/session-learner');
  const learner = new SL({ config });

  // Override DB path for test isolation
  learner._ensureDb = function () {
    if (this.db) return;
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
  };

  return {
    learner,
    tmpDir,
    dbPath,
    cleanup: () => {
      learner.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('SessionLearner', () => {
  describe('schema', () => {
    it('creates session_evaluations table on first access', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        learner._ensureDb();
        const tables = learner.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_evaluations'")
          .all();
        assert.equal(tables.length, 1);
        assert.equal(tables[0].name, 'session_evaluations');
      } finally {
        cleanup();
      }
    });

    it('creates indexes on project_name and score', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        learner._ensureDb();
        const indexes = learner.db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_session_eval_%'")
          .all()
          .map(r => r.name);
        assert.ok(indexes.includes('idx_session_eval_project'));
        assert.ok(indexes.includes('idx_session_eval_score'));
      } finally {
        cleanup();
      }
    });
  });

  describe('recordEvaluation', () => {
    it('inserts evaluation record into SQLite', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        learner.recordEvaluation(makeEval());

        const rows = learner.db.prepare('SELECT * FROM session_evaluations').all();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].project_name, 'test-project');
        assert.equal(rows[0].score, 4);
        assert.equal(rows[0].commit_count, 3);
        assert.equal(rows[0].insertions, 150);
        assert.equal(rows[0].deletions, 20);
        assert.equal(rows[0].files_changed, 5);
        assert.equal(rows[0].recommendation, 'continue');
      } finally {
        cleanup();
      }
    });

    it('classifies prompt style', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        learner.recordEvaluation(makeEval({ prompt: 'Fix the login bug' }));
        const row = learner.db.prepare('SELECT prompt_style FROM session_evaluations').get();
        assert.equal(row.prompt_style, 'fix');
      } finally {
        cleanup();
      }
    });

    it('truncates prompt snippet to 200 chars', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        const longPrompt = 'x'.repeat(300);
        learner.recordEvaluation(makeEval({ prompt: longPrompt }));
        const row = learner.db.prepare('SELECT prompt_snippet FROM session_evaluations').get();
        assert.equal(row.prompt_snippet.length, 200);
      } finally {
        cleanup();
      }
    });

    it('stores full prompt when under 200 chars', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        learner.recordEvaluation(makeEval({ prompt: 'short prompt' }));
        const row = learner.db.prepare('SELECT prompt_snippet FROM session_evaluations').get();
        assert.equal(row.prompt_snippet, 'short prompt');
      } finally {
        cleanup();
      }
    });
  });

  describe('_classifyPromptStyle', () => {
    it('classifies fix/bug/error as fix', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        assert.equal(learner._classifyPromptStyle('Fix the broken auth'), 'fix');
        assert.equal(learner._classifyPromptStyle('There is a bug in parser'), 'fix');
        assert.equal(learner._classifyPromptStyle('Debug the error handler'), 'fix');
      } finally {
        cleanup();
      }
    });

    it('classifies implement/add/create/build as implement', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        assert.equal(learner._classifyPromptStyle('Implement user auth'), 'implement');
        assert.equal(learner._classifyPromptStyle('Add rate limiting'), 'implement');
        assert.equal(learner._classifyPromptStyle('Create new endpoint'), 'implement');
        assert.equal(learner._classifyPromptStyle('Build the dashboard'), 'implement');
      } finally {
        cleanup();
      }
    });

    it('classifies explore/read/understand/investigate as explore', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        assert.equal(learner._classifyPromptStyle('Explore the codebase'), 'explore');
        assert.equal(learner._classifyPromptStyle('Read the test suite'), 'explore');
        assert.equal(learner._classifyPromptStyle('Understand the architecture'), 'explore');
        assert.equal(learner._classifyPromptStyle('Investigate the memory leak'), 'explore');
      } finally {
        cleanup();
      }
    });

    it('classifies resume/continue as resume', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        assert.equal(learner._classifyPromptStyle('Resume where we left off'), 'resume');
        assert.equal(learner._classifyPromptStyle('Continue the migration'), 'resume');
        assert.equal(learner._classifyPromptStyle('Pick up where left off'), 'resume');
      } finally {
        cleanup();
      }
    });

    it('classifies unknown prompts as custom', () => {
      const { learner, cleanup } = createTestLearner();
      try {
        assert.equal(learner._classifyPromptStyle('Deploy to production'), 'custom');
        assert.equal(learner._classifyPromptStyle('Run the test suite'), 'custom');
        assert.equal(learner._classifyPromptStyle(''), 'custom');
        assert.equal(learner._classifyPromptStyle(null), 'custom');
      } finally {
        cleanup();
      }
    });
  });

  describe('analyzePatterns', () => {
    it('returns null below minEvaluations threshold', () => {
      const { learner, cleanup } = createTestLearner({ minEvaluations: 50 });
      try {
        // Insert 10 evaluations (below 50 threshold)
        for (let i = 0; i < 10; i++) {
          learner.recordEvaluation(makeEval({ score: 4 }));
        }

        const patterns = learner.analyzePatterns();
        assert.equal(patterns, null);
      } finally {
        cleanup();
      }
    });

    it('returns patterns above threshold with per-project data', () => {
      const { learner, cleanup } = createTestLearner({ minEvaluations: 5 });
      try {
        // Insert 6 evaluations for 2 projects (3 each, meets min 3 per project)
        for (let i = 0; i < 3; i++) {
          learner.recordEvaluation(makeEval({ projectName: 'project-a', score: 4 }));
          learner.recordEvaluation(makeEval({ projectName: 'project-b', score: 3 }));
        }

        const patterns = learner.analyzePatterns();
        assert.ok(patterns !== null);
        assert.equal(patterns.totalEvaluations, 6);
        assert.ok(Array.isArray(patterns.byProject));
        assert.ok(patterns.byProject.length >= 2);
        // project-a should have higher avg score
        const projA = patterns.byProject.find(p => p.project_name === 'project-a');
        assert.ok(projA !== undefined);
        assert.equal(projA.avg_score, 4);
      } finally {
        cleanup();
      }
    });

    it('returns per-style data when enough sessions exist', () => {
      const { learner, cleanup } = createTestLearner({ minEvaluations: 10 });
      try {
        // Insert 10 evaluations with different styles (5 implement, 5 fix)
        for (let i = 0; i < 5; i++) {
          learner.recordEvaluation(makeEval({ prompt: 'Implement feature', score: 4 }));
          learner.recordEvaluation(makeEval({ prompt: 'Fix the bug', score: 3 }));
        }

        const patterns = learner.analyzePatterns();
        assert.ok(patterns !== null);
        assert.ok(Array.isArray(patterns.byStyle));
        assert.ok(patterns.byStyle.length >= 2);
      } finally {
        cleanup();
      }
    });

    it('includes duration and time-of-day patterns', () => {
      const { learner, cleanup } = createTestLearner({ minEvaluations: 5 });
      try {
        for (let i = 0; i < 6; i++) {
          learner.recordEvaluation(makeEval({ score: 4, durationMinutes: 30 }));
        }

        const patterns = learner.analyzePatterns();
        assert.ok(patterns !== null);
        assert.ok(patterns.optimalDuration !== undefined);
        assert.ok(Array.isArray(patterns.byTimeOfDay));
      } finally {
        cleanup();
      }
    });
  });

  describe('formatForContext', () => {
    it('returns insufficient data message below threshold', () => {
      const { learner, cleanup } = createTestLearner({ minEvaluations: 50 });
      try {
        for (let i = 0; i < 5; i++) {
          learner.recordEvaluation(makeEval());
        }

        const result = learner.formatForContext();
        assert.ok(result.includes('Insufficient data'));
        assert.ok(result.includes('5/50'));
      } finally {
        cleanup();
      }
    });

    it('returns pattern insights above threshold', () => {
      const { learner, cleanup } = createTestLearner({ minEvaluations: 5 });
      try {
        for (let i = 0; i < 6; i++) {
          learner.recordEvaluation(makeEval({
            projectName: 'project-a',
            prompt: 'Implement auth',
            score: 4,
          }));
        }

        const result = learner.formatForContext();
        assert.ok(result.includes('Session Learnings'));
        assert.ok(result.includes('6 evaluations'));
        assert.ok(!result.includes('Insufficient data'));
      } finally {
        cleanup();
      }
    });

    it('includes project and style info when data exists', () => {
      const { learner, cleanup } = createTestLearner({ minEvaluations: 10 });
      try {
        // Need enough evaluations to trigger analysis
        for (let i = 0; i < 5; i++) {
          learner.recordEvaluation(makeEval({
            projectName: 'web-scraping',
            prompt: 'Implement scraper',
            score: 5,
          }));
          learner.recordEvaluation(makeEval({
            projectName: 'web-scraping',
            prompt: 'Fix the parser bug',
            score: 3,
          }));
        }

        const result = learner.formatForContext();
        assert.ok(result.includes('web-scraping'));
      } finally {
        cleanup();
      }
    });
  });

  describe('close', () => {
    it('closes the database connection', () => {
      const { learner, tmpDir } = createTestLearner();
      try {
        learner._ensureDb();
        assert.ok(learner.db !== null);
        learner.close();
        assert.equal(learner.db, null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('is safe to call multiple times', () => {
      const { learner, tmpDir } = createTestLearner();
      try {
        learner._ensureDb();
        learner.close();
        learner.close(); // Should not throw
        assert.equal(learner.db, null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
