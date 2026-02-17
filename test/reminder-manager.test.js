'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Create a ReminderManager with a temp DB for test isolation.
 * Overrides _ensureDb to use a temp directory instead of orchestrator.db.
 */
function createTestManager() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const notifications = [];
  const mockNotificationManager = {
    notify(text, tier) {
      notifications.push({ text, tier });
    },
  };

  const RM = require('../lib/reminder-manager');
  const manager = new RM({
    config: { reminders: { enabled: true, timezone: 'America/New_York' } },
    notificationManager: mockNotificationManager,
  });

  // Override DB path for test isolation
  manager._ensureDb = function () {
    if (this.db) return;
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
  };

  return {
    manager,
    notifications,
    tmpDir,
    cleanup: () => {
      manager.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('ReminderManager', () => {
  describe('schema', () => {
    it('creates reminders table on first access', () => {
      const { manager, cleanup } = createTestManager();
      try {
        manager._ensureDb();
        const tables = manager.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reminders'")
          .all();
        assert.equal(tables.length, 1);
        assert.equal(tables[0].name, 'reminders');
      } finally {
        cleanup();
      }
    });
  });

  describe('setReminder', () => {
    it('inserts a pending reminder and returns its id', () => {
      const { manager, cleanup } = createTestManager();
      try {
        const id = manager.setReminder('Check YouTube OAuth', '2026-02-20T10:00:00Z');
        assert.ok(id > 0, 'should return a positive id');

        const rows = manager.db.prepare('SELECT * FROM reminders WHERE id = ?').all(id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].text, 'Check YouTube OAuth');
        assert.equal(rows[0].fire_at, '2026-02-20T10:00:00Z');
        assert.equal(rows[0].fired, 0);
      } finally {
        cleanup();
      }
    });

    it('stores source_message when provided', () => {
      const { manager, cleanup } = createTestManager();
      try {
        const id = manager.setReminder('Test', '2026-02-20T10:00:00Z', 'remind me to test tomorrow');
        const row = manager.db.prepare('SELECT source_message FROM reminders WHERE id = ?').get(id);
        assert.equal(row.source_message, 'remind me to test tomorrow');
      } finally {
        cleanup();
      }
    });
  });

  describe('checkAndFire', () => {
    it('fires past reminders with URGENT tier', () => {
      const { manager, notifications, cleanup } = createTestManager();
      try {
        // Set a reminder in the past
        const pastTime = new Date(Date.now() - 60000).toISOString();
        manager.setReminder('Past reminder', pastTime);

        const fired = manager.checkAndFire();
        assert.equal(fired, 1);
        assert.equal(notifications.length, 1);
        assert.ok(notifications[0].text.includes('Past reminder'));
        assert.equal(notifications[0].tier, 1); // URGENT
      } finally {
        cleanup();
      }
    });

    it('skips future reminders', () => {
      const { manager, notifications, cleanup } = createTestManager();
      try {
        const futureTime = new Date(Date.now() + 3600000).toISOString();
        manager.setReminder('Future reminder', futureTime);

        const fired = manager.checkAndFire();
        assert.equal(fired, 0);
        assert.equal(notifications.length, 0);
      } finally {
        cleanup();
      }
    });

    it('marks fired reminders as fired=1', () => {
      const { manager, cleanup } = createTestManager();
      try {
        const pastTime = new Date(Date.now() - 60000).toISOString();
        const id = manager.setReminder('Fire me', pastTime);

        manager.checkAndFire();
        const row = manager.db.prepare('SELECT fired FROM reminders WHERE id = ?').get(id);
        assert.equal(row.fired, 1);
      } finally {
        cleanup();
      }
    });

    it('does not double-fire already fired reminders', () => {
      const { manager, notifications, cleanup } = createTestManager();
      try {
        const pastTime = new Date(Date.now() - 60000).toISOString();
        manager.setReminder('Once only', pastTime);

        manager.checkAndFire();
        assert.equal(notifications.length, 1);

        // Second call should not fire again
        const fired2 = manager.checkAndFire();
        assert.equal(fired2, 0);
        assert.equal(notifications.length, 1);
      } finally {
        cleanup();
      }
    });

    it('returns 0 when no reminders exist', () => {
      const { manager, cleanup } = createTestManager();
      try {
        const fired = manager.checkAndFire();
        assert.equal(fired, 0);
      } finally {
        cleanup();
      }
    });
  });

  describe('listPending', () => {
    it('returns empty array when none exist', () => {
      const { manager, cleanup } = createTestManager();
      try {
        const pending = manager.listPending();
        assert.deepEqual(pending, []);
      } finally {
        cleanup();
      }
    });

    it('returns only unfired reminders sorted by fire_at', () => {
      const { manager, cleanup } = createTestManager();
      try {
        const later = new Date(Date.now() + 7200000).toISOString();
        const sooner = new Date(Date.now() + 3600000).toISOString();
        manager.setReminder('Later', later);
        manager.setReminder('Sooner', sooner);

        // Fire one past reminder so we can verify it's excluded
        const pastTime = new Date(Date.now() - 60000).toISOString();
        manager.setReminder('Past', pastTime);
        manager.checkAndFire();

        const pending = manager.listPending();
        assert.equal(pending.length, 2);
        assert.equal(pending[0].text, 'Sooner');
        assert.equal(pending[1].text, 'Later');
      } finally {
        cleanup();
      }
    });
  });

  describe('cancelByText', () => {
    it('cancels matching reminders', () => {
      const { manager, cleanup } = createTestManager();
      try {
        const futureTime = new Date(Date.now() + 3600000).toISOString();
        manager.setReminder('Check YouTube OAuth', futureTime);
        manager.setReminder('Check something else', futureTime);

        const cancelled = manager.cancelByText('YouTube');
        assert.equal(cancelled, 1);

        const pending = manager.listPending();
        assert.equal(pending.length, 1);
        assert.equal(pending[0].text, 'Check something else');
      } finally {
        cleanup();
      }
    });

    it('returns 0 when no match found', () => {
      const { manager, cleanup } = createTestManager();
      try {
        const futureTime = new Date(Date.now() + 3600000).toISOString();
        manager.setReminder('Something', futureTime);

        const cancelled = manager.cancelByText('nonexistent');
        assert.equal(cancelled, 0);
      } finally {
        cleanup();
      }
    });
  });

  describe('close', () => {
    it('closes the database connection', () => {
      const { manager, tmpDir } = createTestManager();
      try {
        manager._ensureDb();
        assert.ok(manager.db !== null);
        manager.close();
        assert.equal(manager.db, null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('is safe to call multiple times', () => {
      const { manager, tmpDir } = createTestManager();
      try {
        manager._ensureDb();
        manager.close();
        manager.close(); // Should not throw
        assert.equal(manager.db, null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
