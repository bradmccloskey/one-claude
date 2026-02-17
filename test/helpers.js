'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Create a temporary directory for test isolation.
 * @param {string} [prefix='orch-test-'] - Directory name prefix
 * @returns {{ dir: string, cleanup: () => void }}
 */
function createTempDir(prefix = 'orch-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a mock claudeP function that returns canned responses.
 * Tracks all invocations in `.calls` for assertion.
 *
 * @param {Array<string|Function>} responses - Canned responses (strings or functions returning strings)
 * @returns {Function} Mock function with same signature as claudeP(prompt, options)
 */
function mockClaudeP(responses) {
  let index = 0;
  const calls = [];

  const mock = function mockClaudePFn(prompt, options = {}) {
    if (index >= responses.length) {
      throw new Error('No more mock responses');
    }
    calls.push({ prompt, options });
    const response = responses[index++];
    return typeof response === 'function' ? response(prompt, options) : response;
  };

  mock.calls = calls;
  return mock;
}

/**
 * Create a standard mock dependency object for constructing orchestrator components.
 * Override any dependency by passing it in the overrides object.
 *
 * @param {Object} [overrides={}] - Specific dependencies to override
 * @returns {Object} Complete mock dependency object
 */
function createMockDeps(overrides = {}) {
  return {
    scanner: { scanAll: () => [], scanProject: () => null },
    processMonitor: { checkProjects: () => ({}) },
    digest: { formatMorningDigest: () => '', formatProjectDetail: () => '' },
    scheduler: { isQuietTime: () => false },
    sessionManager: {
      getActiveSessions: () => [],
      getSessionStatuses: () => [],
      startSession: () => ({ success: true, message: 'started' }),
      stopSession: () => ({ success: true, message: 'stopped' }),
      restartSession: () => ({ success: true, message: 'restarted' }),
      maxConcurrent: 3,
    },
    signalProtocol: { injectClaudeMd: () => {}, clearSignal: () => {} },
    state: {
      load: () => ({ aiDecisionHistory: [], executionHistory: [], runtimeAutonomyLevel: 'observe' }),
      save: () => {},
      getAutonomyLevel: () => 'observe',
      logDecision: () => {},
      logExecution: () => {},
      getErrorRetryCount: () => 0,
    },
    messenger: { send: () => {} },
    config: { ai: { enabled: true, model: 'sonnet', autonomyLevel: 'observe' }, projects: [] },
    projectNames: [],
    ...overrides,
  };
}

module.exports = { createTempDir, mockClaudeP, createMockDeps };
