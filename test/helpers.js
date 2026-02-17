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
      load: () => ({ aiDecisionHistory: [], executionHistory: [], evaluationHistory: [], healthRestartHistory: [], runtimeAutonomyLevel: 'observe' }),
      save: () => {},
      getAutonomyLevel: () => 'observe',
      logDecision: () => {},
      logExecution: () => {},
      logEvaluation: () => {},
      getRecentEvaluations: () => [],
      getErrorRetryCount: () => 0,
      logHealthRestart: () => {},
      getRecentHealthRestarts: () => [],
    },
    messenger: { send: () => {} },
    gitTracker: {
      getProgress: () => ({
        commitCount: 0, insertions: 0, deletions: 0, filesChanged: 0,
        fileList: [], lastCommitHash: null, lastCommitMessage: null,
        lastCommitTimestamp: null, noGit: false,
      }),
    },
    resourceMonitor: {
      getSnapshot: () => ({
        cpuLoadAvg1m: 2.0, cpuLoadAvg5m: 1.5, cpuCount: 8,
        freeMemMB: 4096, totalMemMB: 16384, memUsedPct: 75,
        diskUsedPct: 45, uptimeHours: 100,
      }),
      formatForContext: () => 'System: CPU 2.0/8 cores | RAM 4096MB free/16384MB (75% used) | Disk 45% used | Uptime 100h',
    },
    sessionEvaluator: {
      evaluate: async () => ({
        score: 3, recommendation: 'continue',
        accomplishments: [], failures: [], reasoning: 'mock',
      }),
    },
    healthMonitor: {
      checkAll: async () => {},
      getLastResults: () => ({}),
      formatForContext: () => 'Service Health: all mocked',
      getStats: () => ({ total: 0, up: 0, down: 0, services: [] }),
    },
    mcpBridge: {
      queryMCP: async () => 'mock MCP response',
      isServerAvailable: () => true,
      getCircuitBreakerStates: () => ({}),
      formatForContext: () => 'MCP Capabilities: all mocked',
    },
    revenueTracker: {
      collect: async () => {},
      getLatest: () => ({ 'xmr-mining': null, 'mlx-api': null }),
      formatForContext: () => 'Revenue: all mocked',
      getWeeklyTrend: () => ({ thisWeek: { xmr: null, mlx: null }, lastWeek: { xmr: null, mlx: null } }),
      close: () => {},
    },
    trustTracker: {
      update: () => {},
      checkPromotion: () => null,
      formatForContext: () => 'Trust Metrics: all mocked',
      getMetrics: () => ({ level: 'observe', sessions: 0, avgScore: 0, days: 0, promotionProgress: null }),
      resetPromotionFlag: () => {},
      close: () => {},
    },
    reminderManager: {
      setReminder: () => 1,
      checkAndFire: () => 0,
      listPending: () => [],
      cancelByText: () => 0,
      close: () => {},
    },
    sessionLearner: {
      recordEvaluation: () => {},
      analyzePatterns: () => null,
      formatForContext: () => 'Session Learnings: Insufficient data (0/50 evaluations)',
      close: () => {},
    },
    conversationStore: {
      push: () => {},
      getRecent: () => [],
      getAll: () => [],
      search: () => [],
      clear: () => {},
      close: () => {},
    },
    config: { ai: { enabled: true, model: 'sonnet', autonomyLevel: 'observe' }, projects: [] },
    projectNames: [],
    ...overrides,
  };
}

module.exports = { createTempDir, mockClaudeP, createMockDeps };
