---
phase: 02-autonomous-execution-and-intelligence
plan: 01
subsystem: notification-and-state
tags: [notification-tiers, sms-budget, batching, state-versioning, error-tracking, autonomy-level]
dependency_graph:
  requires: [01-01, 01-02, 01-03]
  provides: [notification-manager, phase2-config, state-extensions]
  affects: [02-02, 02-03, 02-04]
tech_stack:
  added: []
  patterns: [tier-based-routing, daily-budget-enforcement, batch-queue-flush, optimistic-locking-version, runtime-autonomy-override]
key_files:
  created:
    - lib/notification-manager.js
  modified:
    - config.json
    - lib/state.js
decisions:
  - id: notification-wrapper
    decision: "NotificationManager wraps Messenger rather than replacing it"
    reason: "Messenger handles iMessage delivery; NotificationManager handles prioritization, batching, and budgeting"
  - id: budget-urgent-bypass
    decision: "Tier 1 (URGENT) always bypasses daily SMS budget"
    reason: "Critical alerts like session errors must always reach the user"
  - id: state-version-explicit
    decision: "incrementVersion() is called explicitly, not auto-incremented in save()"
    reason: "Prevents double-increments since many methods call save() internally"
  - id: autonomy-in-state
    decision: "Runtime autonomy level stored in .state.json, not config.json"
    reason: "Config.json is the default; .state.json holds runtime overrides that survive restarts"
metrics:
  duration: "~3 minutes"
  completed: "2026-02-16"
---

# Phase 02 Plan 01: Foundation Layer (Notifications, Config, State) Summary

**Tier-based NotificationManager wrapping Messenger with daily SMS budget, batch queue, and quiet-hours awareness; config.json extended with Phase 2 AI fields; state.js extended with version tracking, execution history, error retry counts, and runtime autonomy level**

## What Was Done

### Task 1: Create NotificationManager and extend config.json
- Created `lib/notification-manager.js` (198 lines) with 4 notification tiers:
  - URGENT (1): Immediate send, bypasses quiet hours and daily budget, piggybacks batch flush
  - ACTION (2): Immediate during non-quiet hours, queued during quiet, counts against budget
  - SUMMARY (3): Added to batch queue, flushed on interval or piggybacked with tier 1/2
  - DEBUG (4): console.log only, never SMS
- Daily SMS budget enforcement (default 20/day) with midnight reset
  - Urgent bypasses budget; ACTION downgrades to batch when budget exhausted
  - 80% budget warning logged
- Batch queue with configurable interval flush (default 4 hours) via `startBatchTimer()`/`stopBatchTimer()`
- Batch messages truncated to 1500 chars
- Added Phase 2 config fields to `config.json` `ai` section: `maxSessionDurationMs` (2700000), `maxErrorRetries` (3), `stalenessDays` (3), `notifications` subsection
- Zero new npm dependencies
- Commit: `d5cb55a`

### Task 2: Extend state.js with version tracking, execution history, error retries, autonomy level
- Added `stateVersion` counter (default 0) with `incrementVersion(state)` method for optimistic locking
- Added `executionHistory` array with `logExecution(state, record)` method, capped at 100 entries
- Added `errorRetryCounts` object with `recordErrorRetry()`, `getErrorRetryCount()`, `clearErrorRetries()`
- Added `runtimeAutonomyLevel` with `setAutonomyLevel()` (validates against allowed levels) and `getAutonomyLevel()` (runtime override > config default > 'observe')
- Full backward compatibility: old `.state.json` files load without errors, new fields have safe defaults
- Commit: `412ff97`

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| NotificationManager wraps Messenger, not replaces it | Separation of concerns: delivery vs. prioritization/budgeting |
| Tier 1 always bypasses budget and quiet hours (when configured) | Critical alerts must reach user regardless of budget state |
| Piggyback batch flush on tier 1/2 sends | Reduces total SMS count by combining batched items with immediate sends |
| incrementVersion() explicit, not in save() | Prevents double-increments; callers who want version tracking call it explicitly |
| Runtime autonomy level in .state.json | Config.json holds the default; .state.json holds runtime SMS-set overrides |
| Execution history capped at 100 (vs 50 for decisions) | Execution records are more granular; 100 covers ~8 hours at full autonomy |
| Static AUTONOMY_LEVELS constant on StateManager | Single source of truth for valid levels; used by setAutonomyLevel validation |

## Verification Results

- `NotificationManager` exports as function (class) -- PASS
- `config.json` has maxSessionDurationMs=2700000, notifications.dailyBudget=20 -- PASS
- Tier routing: debug=log-only, urgent=immediate, action=immediate-if-non-quiet, summary=batch -- PASS
- Budget enforcement: tier 2 downgrades to batch when exhausted, tier 1 bypasses -- PASS
- Quiet hours: tier 2 queued during quiet, tier 1 sends (with bypass config) -- PASS
- Batch piggyback: tier 1/2 sends trigger batch flush -- PASS
- state.js defaults: stateVersion=0, executionHistory=[], runtimeAutonomyLevel=null -- PASS
- incrementVersion(): 0 -> 1 after call -- PASS
- logExecution(): array grows, capped at 100 -- PASS
- recordErrorRetry()/getErrorRetryCount()/clearErrorRetries(): increment/read/clear -- PASS
- setAutonomyLevel(): validates, rejects invalid, persists -- PASS
- getAutonomyLevel(): runtime > config > 'observe' fallback -- PASS
- Backward compatibility: old state files load cleanly, new methods work on them -- PASS
- All existing modules import without errors -- PASS
- Zero new npm dependencies (still only better-sqlite3, node-cron) -- PASS

## Deviations from Plan

None -- plan executed exactly as written.

## Next Phase Readiness

Plan 02-02 (Decision Executor Wiring) can proceed. It will:
- Import `NotificationManager` from `lib/notification-manager.js` for tier-based notifications
- Use `state.incrementVersion()` for optimistic locking before/after execution
- Use `state.logExecution()` to record executed actions
- Use `state.recordErrorRetry()` / `getErrorRetryCount()` for error recovery caps
- Use `state.getAutonomyLevel()` to determine execution permissions
- Read `config.ai.maxSessionDurationMs`, `maxErrorRetries`, `stalenessDays` for time boxing and error recovery
