---
phase: 01-ai-brain-foundation
plan: 02
subsystem: ai-brain
tags: [ai-brain, decision-executor, think-cycle, claude-cli, safety-guardrails]
dependency_graph:
  requires: [01-01]
  provides: [ai-brain, decision-executor, decision-history]
  affects: [01-03]
tech_stack:
  added: []
  patterns: [think-cycle, mutex-guard, robust-json-parsing, action-allowlist, cooldown-tracking]
key_files:
  created:
    - lib/ai-brain.js
    - lib/decision-executor.js
  modified:
    - lib/state.js
decisions:
  - id: stdin-pipe
    decision: "Pass prompt to claude -p via execSync input option (stdin pipe, no temp files)"
    reason: "Clean single approach, no filesystem side effects, no cleanup needed"
  - id: 30s-timeout
    decision: "30-second timeout on claude -p execution"
    reason: "Matches phase success criteria of sub-30s think cycles, prevents hangs"
  - id: json-parser-strategy
    decision: "Three-stage JSON parser: direct parse, markdown fences, outermost braces"
    reason: "Claude responses often wrap JSON in prose or markdown; need to handle all formats"
  - id: observe-scaffold
    decision: "DecisionExecutor.execute() is a no-op scaffold in Phase 1"
    reason: "Safety-first: observe mode validates and formats but never acts"
metrics:
  duration: "~3 minutes"
  completed: "2026-02-16"
---

# Phase 01 Plan 02: AI Brain + Decision Executor Summary

**AIBrain class with claude -p think cycle, robust JSON parsing, resource guards; DecisionExecutor scaffold with action allowlist, cooldowns, and observe-mode safety**

## What Was Done

### Task 1: Extend state.js and create ai-brain.js
- Extended `state.js` with `logDecision(state, decision)` -- persists decisions to `aiDecisionHistory` array, trims to 50 entries
- Added `getRecentDecisions(state, count)` -- returns last N entries from history
- Updated `load()` default state to include `aiDecisionHistory: []` (backward compatible)
- Created `lib/ai-brain.js` -- `AIBrain` class with full think cycle:
  - `think()`: assembles context, shells to `claude -p` with stdin piping, parses JSON, logs to state, passes to executor
  - `parseJSON(text)`: robust three-stage parser (direct, markdown fences, outermost braces)
  - `_checkResources()`: validates free memory against `config.ai.resourceLimits.minFreeMemoryMB`
  - `enable()`/`disable()`/`isEnabled()`: runtime toggle
  - `getStatus()`: returns enabled, lastThinkTime, thinking mutex, autonomyLevel, decision count
  - `getLastDecision()`: retrieves most recent decision from state history
  - Mutex prevents concurrent think cycles (`this._thinking` flag in try/finally)
  - Three distinct error handlers: timeout (ETIMEDOUT), non-zero exit, general exec error
- Commit: `1486ba6`

### Task 2: Create decision-executor.js scaffold
- Created `lib/decision-executor.js` -- `DecisionExecutor` class with safety guardrails:
  - `ALLOWED_ACTIONS`: static allowlist `['start', 'stop', 'restart', 'notify', 'skip']`
  - `evaluate(recommendations)`: validates each recommendation against allowlist, protected projects, and cooldowns
  - `formatForSMS(evaluatedRecommendations, summary)`: produces clean SMS text under 1500 chars
  - `execute(evaluatedRecommendation)`: Phase 1 scaffold, logs warning and returns `{ executed: false, reason: "observe mode" }`
  - `_checkCooldown(project, action)`: checks same-action and same-project cooldown windows
  - `_recordAction(project, action)`: updates cooldown timestamps (used by future Phase 2 execution)
- Commit: `0b58816`

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Pass prompt via execSync `input` option (stdin pipe) | Clean approach, no temp files, no cleanup needed |
| 30-second timeout on `claude -p` | Matches sub-30s think cycle target, prevents process hangs |
| Three-stage JSON parser (direct, fences, braces) | Claude responses often wrap JSON in prose or markdown |
| DecisionExecutor.execute() is a no-op in Phase 1 | Safety-first: observe validates and formats but never acts |
| Cooldown tracking is per-instance (in-memory) | Simple for Phase 1; persistent cooldowns can be added later if needed |

## Verification Results

- state.js logDecision persists and trims to 50 entries -- PASS
- ai-brain.js AIBrain class exports correctly -- PASS
- parseJSON handles bare JSON, markdown fences, and JSON in prose -- PASS (3/3 cases)
- decision-executor.js rejects unknown actions -- PASS
- decision-executor.js rejects protected projects -- PASS
- decision-executor.js cooldown enforcement -- PASS
- Observe mode: all validated recommendations have observeOnly=true -- PASS
- state.js backward compatible (original fields preserved) -- PASS
- All 12 existing modules load without error -- PASS
- Zero new npm dependencies -- PASS
- execute() scaffold returns observe mode refusal -- PASS

## Deviations from Plan

None -- plan executed exactly as written.

## Next Phase Readiness

Plan 01-03 (Integration + Wiring) can proceed. It will:
- Import `AIBrain` from `lib/ai-brain.js` and wire it into the main orchestrator loop
- Import `DecisionExecutor` from `lib/decision-executor.js` and connect to AIBrain
- Wire the think cycle into the scheduler with `config.ai.thinkIntervalMs` timing
- Add SMS commands for `ai on`, `ai off`, `ai status`, `ai think`
