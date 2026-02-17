---
phase: 04-session-intelligence
plan: 02
subsystem: session-intelligence
tags: [llm-judge, session-evaluation, state-persistence]
completed: 2026-02-17
duration: ~2m

requires:
  - 04-01 (GitTracker for git progress queries)

provides:
  - SessionEvaluator class with LLM-as-judge evaluate() method
  - EVALUATION_SCHEMA for structured scoring responses
  - StateManager.logEvaluation() and getRecentEvaluations() methods

affects:
  - 04-03 (SessionLifecycle will call evaluate() after session stop)
  - 04-04 (PerformanceTracker may use evaluation history)
  - 04-05 (Integration wiring)

tech-stack:
  added: none
  patterns:
    - LLM-as-judge with JSON schema structured output
    - Fallback heuristic scoring when LLM unavailable
    - DI constructor pattern (gitTracker, state, config)

key-files:
  created:
    - lib/session-evaluator.js
  modified:
    - lib/state.js
---

# Phase 04 Plan 02: Session Evaluator Summary

LLM-as-judge session quality scoring with structured evaluation schema and state persistence, enabling the orchestrator to learn whether sessions accomplish their objectives.

## What Was Built

### SessionEvaluator (lib/session-evaluator.js)

The `evaluate()` method follows a 7-step pipeline:

1. **Capture tmux output** -- `tmux capture-pane -t <session> -p -S -200 -J` with ANSI stripping and 2000-char truncation
2. **Get git progress** -- via `gitTracker.getProgress(projectDir, startedAt)` for commit counts, insertions, deletions, files changed
3. **Calculate duration** -- minutes since session start
4. **Build evaluation prompt** -- structured rubric (1-5 scale) with objective evidence and terminal output
5. **Call LLM judge** -- via `claudePWithSemaphore` with `EVALUATION_SCHEMA` for structured JSON response
6. **Build evaluation record** -- combines git progress, LLM scoring, and session metadata
7. **Persist** -- writes to `.orchestrator/evaluation.json` per project AND logs to state `evaluationHistory[]`

**Fallback path:** If LLM judge fails (timeout, parse error, unavailable), scores based on commit count heuristic: 0 commits = score 1, 1-2 = score 3, 3+ = score 4.

### EVALUATION_SCHEMA

JSON schema string compatible with `claudePWithSemaphore`'s `--json-schema` flag:
- `score`: integer 1-5
- `recommendation`: enum [continue, retry, escalate, complete]
- `accomplishments`: string array
- `failures`: string array
- `reasoning`: string

### State Evaluation History (lib/state.js)

- `logEvaluation(state, evaluation)` -- appends to `evaluationHistory[]`, capped at 100 entries
- `getRecentEvaluations(state, count)` -- returns last N evaluations (default 5)
- Default state now includes `evaluationHistory: []`

## Decisions Made

No new architectural decisions required. Followed established patterns:
- DI constructor pattern (same as all Phase 4 modules)
- Defense-in-depth JSON.parse after --json-schema (same as ai-brain.js, per 03-03 decision)
- History capping pattern (100 entries, same as executionHistory)

## Deviations from Plan

None -- plan executed exactly as written.

## Verification

- `require('./lib/session-evaluator')` loads without error
- `require('./lib/state')` loads without error
- EVALUATION_SCHEMA parses as valid JSON with all 5 required fields
- `logEvaluation()` persists to disk, `getRecentEvaluations()` retrieves
- No new npm dependencies (still only better-sqlite3 and node-cron)
- All 16 existing tests pass (no regressions)

## Commits

| Hash | Message |
|------|---------|
| 2d58760 | feat(04-02): create SessionEvaluator with LLM-as-judge scoring |
| e01885e | feat(04-02): add evaluation history methods to StateManager |
