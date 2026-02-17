---
phase: 03-foundation-hardening
plan: 04
subsystem: testing
tags: [node-test, mocking, semaphore, conversation-store, decision-executor, test-infrastructure]
dependency_graph:
  requires: ["03-01", "03-02"]
  provides: ["test-infrastructure", "test-helpers", "module-coverage"]
  affects: ["04-*", "05-*"]
tech_stack:
  added: []
  patterns: ["node:test runner", "temp-dir isolation", "mock-factory pattern", "FIFO semaphore testing"]
key_files:
  created:
    - test/helpers.js
    - test/exec.test.js
    - test/conversation-store.test.js
    - test/decision-executor.test.js
  modified:
    - package.json
decisions:
  - id: "03-04-01"
    decision: "Use node:test built-in runner (no Jest/Mocha dependency)"
    reason: "Zero new dependencies constraint; node:test is stable in Node v25"
  - id: "03-04-02"
    decision: "Fix package.json test script to use glob pattern test/*.test.js"
    reason: "node --test test/ does not work on Node v25.6.1; needs explicit glob"
  - id: "03-04-03"
    decision: "Test semaphore behavior directly rather than mocking child_process"
    reason: "ClaudeSemaphore is pure async logic; testing it directly is cleaner and more reliable"
metrics:
  duration: "~3m"
  completed: "2026-02-17"
  tests_added: 16
  test_files: 4
---

# Phase 03 Plan 04: Test Infrastructure and Module Tests Summary

**Node.js built-in test runner with 16 tests covering exec semaphore, conversation store, and decision executor**

## What Was Done

### Task 1: Test Helpers and Exec Tests
Created the test infrastructure foundation and semaphore tests:

- **test/helpers.js** (83 lines): Three reusable utilities:
  - `createTempDir()` -- creates isolated temp dirs with cleanup callback
  - `mockClaudeP()` -- canned response factory with call tracking
  - `createMockDeps()` -- full mock dependency object for any orchestrator component
- **test/exec.test.js** (87 lines): 4 tests for ClaudeSemaphore:
  - Concurrent acquire up to max
  - Third acquire blocks until release
  - FIFO ordering of queued waiters
  - Module exports verification

### Task 2: Conversation Store and Decision Executor Tests
Created integration tests for the two modules built in 03-02:

- **test/conversation-store.test.js** (114 lines): 5 tests covering:
  - Disk persistence across store instances
  - maxMessages cap (keeps newest)
  - TTL pruning (removes expired entries)
  - Credential pattern filtering (OpenAI, GitHub, Stripe keys redacted)
  - clear() empties all history
- **test/decision-executor.test.js** (142 lines): 7 tests covering:
  - Action allowlist validation
  - Protected project rejection
  - Observe mode observeOnly flag
  - Non-observe mode flag
  - Content-based dedup (repeated recs return null)
  - TTL expiry allows re-sending
  - Different recommendations not deduped

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed package.json test script for Node v25**

- **Found during:** Task 2 verification
- **Issue:** `node --test test/` fails on Node v25.6.1 with MODULE_NOT_FOUND -- the directory form is not supported
- **Fix:** Changed test script to `node --test test/*.test.js` (glob pattern)
- **Files modified:** package.json
- **Commit:** c6b747a (included in Task 2 commit)

## Decisions Made

1. **node:test over external frameworks** -- Zero dependency constraint means no Jest/Mocha. Node v25's built-in test runner is fully capable.
2. **Glob pattern for test script** -- `test/*.test.js` works reliably; the bare directory form does not on this Node version.
3. **Direct semaphore testing** -- Testing ClaudeSemaphore as pure async logic rather than mocking child_process.execSync is cleaner and more reliable.

## Test Results

```
16 tests, 0 failures
Duration: ~200ms

Suites:
  ClaudeSemaphore         4 tests
  ConversationStore       5 tests
  DecisionExecutor.evaluate()   4 tests
  DecisionExecutor.formatForSMS()  3 tests
```

## Next Phase Readiness

- Test infrastructure is established. Future plans can `require('./test/helpers')` for createTempDir, mockClaudeP, and createMockDeps.
- The `npm test` command works and can be added to CI or pre-commit hooks.
- Known issue FOUND-05 (no test suite) is now resolved.
