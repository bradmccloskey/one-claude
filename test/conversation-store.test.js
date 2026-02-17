'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ConversationStore = require('../lib/conversation-store');
const { createTempDir } = require('./helpers');

/**
 * Helper: create a ConversationStore with a temp DB for test isolation.
 */
function createTestStore(options = {}) {
  const tmp = createTempDir('cs-test-');
  const dbPath = path.join(tmp.dir, 'test.db');
  const store = new ConversationStore({
    dbPath,
    maxMessages: options.maxMessages || 100,
    ttlMs: options.ttlMs || 7 * 24 * 60 * 60 * 1000,
  });
  return {
    store,
    tmp,
    cleanup: () => {
      store.close();
      tmp.cleanup();
    },
  };
}

describe('ConversationStore', () => {
  describe('schema', () => {
    it('creates conversations table on first access', () => {
      const { store, cleanup } = createTestStore();
      try {
        store._ensureDb();
        const tables = store.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
          .all();
        assert.equal(tables.length, 1);
        assert.equal(tables[0].name, 'conversations');
      } finally {
        cleanup();
      }
    });

    it('creates index on ts column', () => {
      const { store, cleanup } = createTestStore();
      try {
        store._ensureDb();
        const indexes = store.db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_conversations_ts'")
          .all();
        assert.equal(indexes.length, 1);
      } finally {
        cleanup();
      }
    });
  });

  describe('push', () => {
    it('inserts entry with role, text, and ts', () => {
      const { store, cleanup } = createTestStore();
      try {
        const ts = Date.now();
        store.push({ role: 'user', text: 'hello world', ts });

        const all = store.getAll();
        assert.equal(all.length, 1);
        assert.equal(all[0].role, 'user');
        assert.equal(all[0].text, 'hello world');
        assert.equal(all[0].ts, ts);
      } finally {
        cleanup();
      }
    });

    it('defaults ts to current time when not provided', () => {
      const { store, cleanup } = createTestStore();
      try {
        const before = Date.now();
        store.push({ role: 'ai', text: 'response' });
        const after = Date.now();

        const all = store.getAll();
        assert.equal(all.length, 1);
        assert.ok(all[0].ts >= before, `ts ${all[0].ts} should be >= ${before}`);
        assert.ok(all[0].ts <= after, `ts ${all[0].ts} should be <= ${after}`);
      } finally {
        cleanup();
      }
    });

    it('filters credentials from text before storage', () => {
      const { store, cleanup } = createTestStore();
      try {
        store.push({ role: 'user', text: 'my key is sk-abc12345678901234567890' });
        const all = store.getAll();
        assert.ok(all[0].text.includes('[REDACTED]'));
        assert.ok(!all[0].text.includes('sk-abc12345678901234567890'));
      } finally {
        cleanup();
      }
    });
  });

  describe('getRecent', () => {
    it('returns last N entries in chronological order', () => {
      const { store, cleanup } = createTestStore();
      try {
        const now = Date.now();
        store.push({ role: 'user', text: 'first', ts: now - 3000 });
        store.push({ role: 'ai', text: 'second', ts: now - 2000 });
        store.push({ role: 'user', text: 'third', ts: now - 1000 });

        const recent = store.getRecent(2);
        assert.equal(recent.length, 2);
        assert.equal(recent[0].text, 'second');
        assert.equal(recent[1].text, 'third');
      } finally {
        cleanup();
      }
    });

    it('defaults to 4 entries', () => {
      const { store, cleanup } = createTestStore();
      try {
        const now = Date.now();
        for (let i = 0; i < 6; i++) {
          store.push({ role: 'user', text: `msg${i}`, ts: now + i * 1000 });
        }

        const recent = store.getRecent();
        assert.equal(recent.length, 4);
      } finally {
        cleanup();
      }
    });
  });

  describe('getAll', () => {
    it('returns all entries in chronological order', () => {
      const { store, cleanup } = createTestStore();
      try {
        const now = Date.now();
        store.push({ role: 'user', text: 'a', ts: now - 2000 });
        store.push({ role: 'ai', text: 'b', ts: now - 1000 });
        store.push({ role: 'user', text: 'c', ts: now });

        const all = store.getAll();
        assert.equal(all.length, 3);
        assert.equal(all[0].text, 'a');
        assert.equal(all[1].text, 'b');
        assert.equal(all[2].text, 'c');
      } finally {
        cleanup();
      }
    });
  });

  describe('search', () => {
    it('finds messages by keyword', () => {
      const { store, cleanup } = createTestStore();
      try {
        store.push({ role: 'user', text: 'deploy the scraping api' });
        store.push({ role: 'ai', text: 'deployment complete' });
        store.push({ role: 'user', text: 'check youtube status' });

        const results = store.search('deploy');
        assert.equal(results.length, 2);
      } finally {
        cleanup();
      }
    });

    it('is case-insensitive', () => {
      const { store, cleanup } = createTestStore();
      try {
        store.push({ role: 'user', text: 'Deploy the API' });

        // SQLite LIKE is case-insensitive for ASCII by default
        const results = store.search('deploy');
        assert.equal(results.length, 1);
      } finally {
        cleanup();
      }
    });

    it('returns empty for no match', () => {
      const { store, cleanup } = createTestStore();
      try {
        store.push({ role: 'user', text: 'hello world' });

        const results = store.search('nonexistent');
        assert.equal(results.length, 0);
      } finally {
        cleanup();
      }
    });

    it('returns array for empty query', () => {
      const { store, cleanup } = createTestStore();
      try {
        store.push({ role: 'user', text: 'hello world' });

        const results = store.search('');
        assert.ok(Array.isArray(results));
      } finally {
        cleanup();
      }
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const { store, cleanup } = createTestStore();
      try {
        store.push({ role: 'user', text: 'one' });
        store.push({ role: 'user', text: 'two' });

        assert.equal(store.getAll().length, 2);
        store.clear();
        assert.equal(store.getAll().length, 0);
      } finally {
        cleanup();
      }
    });
  });

  describe('TTL pruning', () => {
    it('removes entries older than TTL', () => {
      const { store, cleanup } = createTestStore({ ttlMs: 5000 });
      try {
        store.push({ role: 'user', text: 'old msg', ts: Date.now() - 6000 });
        store.push({ role: 'user', text: 'new msg', ts: Date.now() });

        const all = store.getAll();
        assert.equal(all.length, 1);
        assert.equal(all[0].text, 'new msg');
      } finally {
        cleanup();
      }
    });
  });

  describe('maxMessages cap', () => {
    it('keeps only newest N messages', () => {
      const { store, cleanup } = createTestStore({ maxMessages: 3 });
      try {
        const now = Date.now();
        for (let i = 0; i < 5; i++) {
          store.push({ role: 'user', text: `msg${i}`, ts: now + i * 1000 });
        }

        const all = store.getAll();
        assert.equal(all.length, 3);
        assert.equal(all[0].text, 'msg2');
        assert.equal(all[1].text, 'msg3');
        assert.equal(all[2].text, 'msg4');
      } finally {
        cleanup();
      }
    });
  });

  describe('credential filtering', () => {
    it('redacts OpenAI keys', () => {
      const { store, cleanup } = createTestStore();
      try {
        store.push({ role: 'user', text: 'key is sk-abc123def456ghi789012345' });
        const all = store.getAll();
        assert.ok(all[0].text.includes('[REDACTED]'));
        assert.ok(!all[0].text.includes('sk-abc123'), 'OpenAI key value still present');
      } finally {
        cleanup();
      }
    });

    it('redacts Stripe live keys', () => {
      const { store, cleanup } = createTestStore();
      try {
        store.push({ role: 'user', text: 'stripe sk_live_abcdef123456' });
        const all = store.getAll();
        assert.ok(all[0].text.includes('[REDACTED]'));
        assert.ok(!all[0].text.includes('sk_live_abcdef'), 'Stripe key value still present');
      } finally {
        cleanup();
      }
    });

    it('redacts GitHub PATs', () => {
      const { store, cleanup } = createTestStore();
      try {
        store.push({ role: 'user', text: 'token: ghp_abcdef1234567890abcdef1234567890abcd' });
        const all = store.getAll();
        assert.ok(all[0].text.includes('[REDACTED]'));
        assert.ok(!all[0].text.includes('ghp_abcdef'), 'GitHub PAT value still present');
      } finally {
        cleanup();
      }
    });
  });

  describe('persistence', () => {
    it('persists messages to SQLite and loads them back', () => {
      const tmp = createTempDir('cs-persist-');
      const dbPath = path.join(tmp.dir, 'test.db');
      try {
        const store1 = new ConversationStore({ dbPath });
        store1.push({ role: 'user', text: 'hello' });
        store1.push({ role: 'assistant', text: 'hi there' });
        store1.push({ role: 'user', text: 'status?' });
        store1.close();

        // New instance, same DB -- should load persisted data
        const store2 = new ConversationStore({ dbPath });
        const all = store2.getAll();

        assert.equal(all.length, 3);
        assert.equal(all[0].text, 'hello');
        assert.equal(all[1].text, 'hi there');
        assert.equal(all[2].text, 'status?');
        store2.close();
      } finally {
        tmp.cleanup();
      }
    });
  });

  describe('close', () => {
    it('closes the database connection', () => {
      const { store, tmp } = createTestStore();
      try {
        store._ensureDb();
        assert.ok(store.db !== null);
        store.close();
        assert.equal(store.db, null);
      } finally {
        tmp.cleanup();
      }
    });

    it('is safe to call multiple times', () => {
      const { store, tmp } = createTestStore();
      try {
        store._ensureDb();
        store.close();
        store.close(); // Should not throw
        assert.equal(store.db, null);
      } finally {
        tmp.cleanup();
      }
    });
  });
});
