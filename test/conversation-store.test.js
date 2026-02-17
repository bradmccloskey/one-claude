'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ConversationStore = require('../lib/conversation-store');
const { createTempDir } = require('./helpers');

describe('ConversationStore', () => {
  let tmp;
  let store;

  afterEach(() => {
    if (store) {
      store.close();
      store = null;
    }
    if (tmp) {
      tmp.cleanup();
      tmp = null;
    }
  });

  it('persists messages to SQLite and loads them back', () => {
    tmp = createTempDir();
    const dbPath = path.join(tmp.dir, 'test.db');

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
  });

  it('enforces maxMessages cap', () => {
    tmp = createTempDir();
    const dbPath = path.join(tmp.dir, 'test.db');

    store = new ConversationStore({ dbPath, maxMessages: 3 });
    for (let i = 1; i <= 5; i++) {
      store.push({ role: 'user', text: `msg ${i}`, ts: Date.now() + i });
    }

    const all = store.getAll();
    assert.equal(all.length, 3);
    // Should keep the 3 newest
    assert.equal(all[0].text, 'msg 3');
    assert.equal(all[1].text, 'msg 4');
    assert.equal(all[2].text, 'msg 5');
  });

  it('prunes messages older than TTL', () => {
    tmp = createTempDir();
    const dbPath = path.join(tmp.dir, 'test.db');

    store = new ConversationStore({ dbPath, ttlMs: 1000 });
    // Push an old message (2 seconds ago)
    store.push({ role: 'user', text: 'old message', ts: Date.now() - 2000 });
    // Push a recent message
    store.push({ role: 'user', text: 'recent message', ts: Date.now() });

    const all = store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].text, 'recent message');
  });

  it('filters credential patterns', () => {
    tmp = createTempDir();
    const dbPath = path.join(tmp.dir, 'test.db');

    store = new ConversationStore({ dbPath });

    // OpenAI-style key
    store.push({ role: 'user', text: 'my key is sk-abc123def456ghi789012345' });
    // GitHub PAT
    store.push({ role: 'user', text: 'token: ghp_abcdef1234567890abcdef1234567890abcd' });
    // Stripe key
    store.push({ role: 'user', text: 'stripe sk_live_abcdef123456' });

    const all = store.getAll();

    // Secrets should be redacted
    assert.ok(all[0].text.includes('[REDACTED]'), `OpenAI key not redacted: ${all[0].text}`);
    assert.ok(!all[0].text.includes('sk-abc123'), 'OpenAI key value still present');

    assert.ok(all[1].text.includes('[REDACTED]'), `GitHub PAT not redacted: ${all[1].text}`);
    assert.ok(!all[1].text.includes('ghp_abcdef'), 'GitHub PAT value still present');

    assert.ok(all[2].text.includes('[REDACTED]'), `Stripe key not redacted: ${all[2].text}`);
    assert.ok(!all[2].text.includes('sk_live_abcdef'), 'Stripe key value still present');

    // Non-secret text should be preserved
    assert.ok(all[0].text.includes('my key is'));
    assert.ok(all[1].text.includes('token:'));
    assert.ok(all[2].text.includes('stripe'));
  });

  it('clear() removes all messages', () => {
    tmp = createTempDir();
    const dbPath = path.join(tmp.dir, 'test.db');

    store = new ConversationStore({ dbPath });
    store.push({ role: 'user', text: 'one' });
    store.push({ role: 'user', text: 'two' });

    assert.equal(store.getAll().length, 2);

    store.clear();
    assert.equal(store.getAll().length, 0);
  });

  it('search() finds messages by keyword', () => {
    tmp = createTempDir();
    const dbPath = path.join(tmp.dir, 'test.db');

    store = new ConversationStore({ dbPath });
    store.push({ role: 'user', text: 'check the dashboard project' });
    store.push({ role: 'assistant', text: 'dashboard is at 80%' });
    store.push({ role: 'user', text: 'how about the miner?' });

    const results = store.search('dashboard');
    assert.equal(results.length, 2);

    const noResults = store.search('nonexistent');
    assert.equal(noResults.length, 0);
  });

  it('getRecent() returns entries in chronological order', () => {
    tmp = createTempDir();
    const dbPath = path.join(tmp.dir, 'test.db');

    store = new ConversationStore({ dbPath });
    store.push({ role: 'user', text: 'first', ts: Date.now() - 3000 });
    store.push({ role: 'user', text: 'second', ts: Date.now() - 2000 });
    store.push({ role: 'user', text: 'third', ts: Date.now() - 1000 });

    const recent = store.getRecent(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].text, 'second');  // older first
    assert.equal(recent[1].text, 'third');   // newer last
  });

  it('close() closes the DB connection', () => {
    tmp = createTempDir();
    const dbPath = path.join(tmp.dir, 'test.db');

    store = new ConversationStore({ dbPath });
    store.push({ role: 'user', text: 'test' });
    store.close();

    // After close, db should be null
    assert.equal(store.db, null);

    // Re-opening should work (lazy init)
    store.push({ role: 'user', text: 'after reopen' });
    const all = store.getAll();
    assert.equal(all.length, 2);
  });
});
