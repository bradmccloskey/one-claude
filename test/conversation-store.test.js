'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ConversationStore = require('../lib/conversation-store');
const { createTempDir } = require('./helpers');

describe('ConversationStore', () => {
  let tmp;

  afterEach(() => {
    if (tmp) {
      tmp.cleanup();
      tmp = null;
    }
  });

  it('persists messages to disk and loads them back', () => {
    tmp = createTempDir();
    const filePath = path.join(tmp.dir, 'conv.json');

    const store1 = new ConversationStore({ filePath });
    store1.push({ role: 'user', text: 'hello' });
    store1.push({ role: 'assistant', text: 'hi there' });
    store1.push({ role: 'user', text: 'status?' });

    // New instance, same file -- should load persisted data
    const store2 = new ConversationStore({ filePath });
    const all = store2.getAll();

    assert.equal(all.length, 3);
    assert.equal(all[0].text, 'hello');
    assert.equal(all[1].text, 'hi there');
    assert.equal(all[2].text, 'status?');
  });

  it('enforces maxMessages cap', () => {
    tmp = createTempDir();
    const filePath = path.join(tmp.dir, 'conv.json');

    const store = new ConversationStore({ filePath, maxMessages: 3 });
    for (let i = 1; i <= 5; i++) {
      store.push({ role: 'user', text: `msg ${i}` });
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
    const filePath = path.join(tmp.dir, 'conv.json');

    const store = new ConversationStore({ filePath, ttlMs: 1000 });
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
    const filePath = path.join(tmp.dir, 'conv.json');

    const store = new ConversationStore({ filePath });

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
    const filePath = path.join(tmp.dir, 'conv.json');

    const store = new ConversationStore({ filePath });
    store.push({ role: 'user', text: 'one' });
    store.push({ role: 'user', text: 'two' });

    assert.equal(store.getAll().length, 2);

    store.clear();
    assert.equal(store.getAll().length, 0);
  });
});
