'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDir } = require('./helpers');
const { EVALUATION_SCHEMA } = require('../lib/session-evaluator');

describe('SessionEvaluator', () => {
  let tmp;

  afterEach(() => {
    if (tmp) {
      tmp.cleanup();
      tmp = null;
    }
    // Restore exec module if patched
    const execModule = require('../lib/exec');
    if (execModule._origClaudePWithSemaphore) {
      execModule.claudePWithSemaphore = execModule._origClaudePWithSemaphore;
      delete execModule._origClaudePWithSemaphore;
    }
  });

  it('EVALUATION_SCHEMA is valid JSON with required fields', () => {
    const schema = JSON.parse(EVALUATION_SCHEMA);

    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.score, 'schema should have score property');
    assert.ok(schema.properties.recommendation, 'schema should have recommendation property');
    assert.ok(schema.properties.accomplishments, 'schema should have accomplishments property');
    assert.ok(schema.properties.failures, 'schema should have failures property');
    assert.ok(schema.properties.reasoning, 'schema should have reasoning property');
    assert.deepEqual(schema.required, ['score', 'recommendation', 'accomplishments', 'failures', 'reasoning']);
  });

  it('evaluate() returns structured evaluation with mocked LLM', async () => {
    // Patch exec module before requiring SessionEvaluator
    const execModule = require('../lib/exec');
    execModule._origClaudePWithSemaphore = execModule.claudePWithSemaphore;
    execModule.claudePWithSemaphore = async () => {
      return JSON.stringify({
        score: 4,
        recommendation: 'continue',
        accomplishments: ['Added feature X'],
        failures: [],
        reasoning: 'Good progress with 3 commits',
      });
    };

    // Re-require to pick up patched exec (module cache shares reference)
    const { SessionEvaluator } = require('../lib/session-evaluator');
    const GitTracker = require('../lib/git-tracker');

    tmp = createTempDir();
    const projectDir = tmp.dir;

    // Create .orchestrator dir (evaluate writes evaluation.json there)
    fs.mkdirSync(path.join(projectDir, '.orchestrator'), { recursive: true });

    // Mock state with logEvaluation spy
    const logCalls = [];
    const mockState = {
      load: () => ({ evaluationHistory: [] }),
      save: () => {},
      logEvaluation: (state, evaluation) => {
        logCalls.push(evaluation);
      },
    };

    const evaluator = new SessionEvaluator({
      gitTracker: new GitTracker(),
      state: mockState,
      config: {},
    });

    const result = await evaluator.evaluate({
      projectName: 'test-project',
      projectDir,
      sessionName: 'orch-test-session',
      startedAt: new Date(Date.now() - 300000).toISOString(), // 5 min ago
      headBefore: null,
      prompt: 'Fix the tests',
    });

    // Verify structure
    assert.equal(result.score, 4);
    assert.equal(result.recommendation, 'continue');
    assert.equal(result.accomplishments.length, 1);
    assert.equal(result.accomplishments[0], 'Added feature X');
    assert.deepEqual(result.failures, []);
    assert.equal(result.projectName, 'test-project');
    assert.ok(result.evaluatedAt, 'should have evaluatedAt timestamp');
    assert.ok(result.durationMinutes >= 0, 'durationMinutes should be >= 0');

    // Verify evaluation.json was written
    const evalFile = path.join(projectDir, '.orchestrator', 'evaluation.json');
    assert.ok(fs.existsSync(evalFile), 'evaluation.json should be written');
    const persisted = JSON.parse(fs.readFileSync(evalFile, 'utf-8'));
    assert.equal(persisted.score, 4);

    // Verify state.logEvaluation was called
    assert.equal(logCalls.length, 1);
    assert.equal(logCalls[0].score, 4);
  });

  it('evaluate() returns fallback on LLM error', async () => {
    // Patch exec module to throw
    const execModule = require('../lib/exec');
    execModule._origClaudePWithSemaphore = execModule.claudePWithSemaphore;
    execModule.claudePWithSemaphore = async () => {
      throw new Error('LLM unavailable');
    };

    const { SessionEvaluator } = require('../lib/session-evaluator');
    const GitTracker = require('../lib/git-tracker');

    tmp = createTempDir();
    const projectDir = tmp.dir;
    fs.mkdirSync(path.join(projectDir, '.orchestrator'), { recursive: true });

    const mockState = {
      load: () => ({ evaluationHistory: [] }),
      save: () => {},
      logEvaluation: () => {},
    };

    const evaluator = new SessionEvaluator({
      gitTracker: new GitTracker(),
      state: mockState,
      config: {},
    });

    const result = await evaluator.evaluate({
      projectName: 'test-fallback',
      projectDir,
      sessionName: 'orch-test-fallback',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      headBefore: null,
      prompt: 'Do something',
    });

    // Fallback: non-git dir means 0 commits => score 1
    assert.equal(result.score, 1);
    assert.equal(result.recommendation, 'retry');
    assert.ok(result.reasoning.includes('Fallback'), 'reasoning should mention fallback');
    assert.ok(result.failures.length > 0, 'should have at least one failure entry');
  });
});
