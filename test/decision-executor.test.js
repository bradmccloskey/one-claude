'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const DecisionExecutor = require('../lib/decision-executor');
const { createMockDeps } = require('./helpers');

/**
 * Helper to create a DecisionExecutor with mock deps and optional overrides.
 */
function createExecutor(overrides = {}) {
  const deps = createMockDeps(overrides);
  return new DecisionExecutor({
    sessionManager: deps.sessionManager,
    messenger: deps.messenger,
    state: deps.state,
    config: deps.config,
  });
}

describe('DecisionExecutor.evaluate()', () => {
  it('validates recommendations against allowlist', () => {
    const exec = createExecutor();

    const results = exec.evaluate([
      { project: 'test-proj', action: 'start', reason: 'needs work' },
      { project: 'test-proj', action: 'hack', reason: 'bad action' },
    ]);

    assert.equal(results.length, 2);
    assert.equal(results[0].validated, true);
    assert.equal(results[0].rejected, null);

    assert.equal(results[1].validated, false);
    assert.equal(results[1].rejected, 'unknown action');
  });

  it('respects protected projects', () => {
    const exec = createExecutor({
      config: {
        ai: {
          enabled: true,
          autonomyLevel: 'observe',
          protectedProjects: ['secret-project'],
        },
        projects: [],
      },
    });

    const results = exec.evaluate([
      { project: 'secret-project', action: 'start', reason: 'try it' },
    ]);

    assert.equal(results[0].validated, false);
    assert.equal(results[0].rejected, 'protected project');
  });

  it('marks observe mode as observeOnly', () => {
    const exec = createExecutor({
      state: {
        load: () => ({ runtimeAutonomyLevel: 'observe' }),
        getAutonomyLevel: () => 'observe',
        logDecision: () => {},
        logExecution: () => {},
        getErrorRetryCount: () => 0,
        save: () => {},
      },
    });

    const results = exec.evaluate([
      { project: 'test-proj', action: 'start', reason: 'needs work' },
    ]);

    assert.equal(results[0].validated, true);
    assert.equal(results[0].observeOnly, true);
  });

  it('marks non-observe mode as not observeOnly', () => {
    const exec = createExecutor({
      state: {
        load: () => ({ runtimeAutonomyLevel: 'moderate' }),
        getAutonomyLevel: () => 'moderate',
        logDecision: () => {},
        logExecution: () => {},
        getErrorRetryCount: () => 0,
        save: () => {},
      },
    });

    const results = exec.evaluate([
      { project: 'test-proj', action: 'start', reason: 'needs work' },
    ]);

    assert.equal(results[0].validated, true);
    assert.equal(results[0].observeOnly, false);
  });
});

describe('DecisionExecutor.formatForSMS()', () => {
  it('deduplicates repeated recommendations', () => {
    const exec = createExecutor();
    const rec = { project: 'foo', action: 'start', reason: 'needs work', validated: true };

    const first = exec.formatForSMS([rec]);
    assert.ok(first !== null, 'first call should return text');
    assert.ok(typeof first === 'string');

    // Same recommendation again -- should be deduped
    const second = exec.formatForSMS([rec]);
    assert.equal(second, null, 'second call should return null (dedup)');
  });

  it('allows same recommendation after TTL expires', async () => {
    const exec = createExecutor();
    // Override dedup TTL to 100ms
    exec._dedupTtlMs = 100;

    const rec = { project: 'bar', action: 'start', reason: 'needs work', validated: true };

    const first = exec.formatForSMS([rec]);
    assert.ok(first !== null);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 150));

    const second = exec.formatForSMS([rec]);
    assert.ok(second !== null, 'should return text after TTL expired');
  });

  it('different recommendations are not deduped', () => {
    const exec = createExecutor();

    const recA = { project: 'foo', action: 'start', reason: 'reason A', validated: true };
    const recB = { project: 'bar', action: 'start', reason: 'reason B', validated: true };

    const first = exec.formatForSMS([recA]);
    const second = exec.formatForSMS([recB]);

    assert.ok(first !== null, 'recA should produce text');
    assert.ok(second !== null, 'recB should produce text (different rec, not deduped)');
  });
});
