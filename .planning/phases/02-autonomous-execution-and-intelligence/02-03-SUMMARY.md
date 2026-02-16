---
phase: 02-autonomous-execution-and-intelligence
plan: 03
subsystem: context-intelligence
tags: [staleness-detection, error-history, session-timeout, expanded-response-schema, autonomy-level-prompting]
dependency_graph:
  requires: [02-01, 02-02]
  provides: [enriched-ai-context, session-time-boxing, expanded-response-format]
  affects: [02-04]
tech_stack:
  added: []
  patterns: [staleness-flagging, error-signal-aggregation, session-duration-tracking, autonomy-aware-prompting]
key_files:
  created: []
  modified:
    - lib/context-assembler.js
    - index.js
decisions:
  - id: staleness-skip-complete
    decision: "STALE flag only shown for projects whose status does not include 'complete'"
    reason: "Completed projects are expected to be idle; flagging them creates noise"
  - id: error-info-from-signal-and-state
    decision: "Error info aggregated from both .orchestrator/error.json signal files and state.errorRetryCounts"
    reason: "Signal files capture active errors; state captures retry history even after signal cleared"
  - id: timeout-in-scan-interval
    decision: "checkSessionTimeouts() runs alongside proactiveScan() in the same 60s interval"
    reason: "Frequent enough to catch timeouts within 1 minute; no extra timer needed"
  - id: timeout-notification-tier-2
    decision: "Timeout notifications sent at tier 2 (action needed)"
    reason: "Session stopped automatically but user should know; not tier 1 (urgent) since it was handled"
metrics:
  duration: "~5 minutes"
  completed: "2026-02-16"
---

# Phase 02 Plan 03: Context Enrichment and Session Time Boxing Summary

**Staleness detection, error history aggregation, expanded AI response schema with prompt/confidence/notificationTier, autonomy-aware response format, session duration tracking with timeout warnings, and automatic session time boxing at 45min default**

## What Was Done

### Task 1: Enrich context-assembler with staleness, error history, and expanded response schema
- **Staleness detection** in `_formatProject()`: computes days since last activity, flags `STALE (N days idle)` for projects idle >= `stalenessDays` (default 3) unless status includes "complete"
- **Error history** per project: new `_getProjectErrorInfo()` method aggregates error data from `.orchestrator/error.json` signal files and `state.errorRetryCounts`; displays `ERROR: <message>` and `Retries: N/M` in project context
- **`_buildProjectsSection()` updated**: loads error retry counts from state, passes error info to `_formatProject()` for each project
- **Expanded response format** in `_buildResponseFormat()`:
  - Added optional `prompt` field (targeted instructions for start/restart sessions)
  - Added optional `confidence` field (0-1 score)
  - Added optional `notificationTier` field (1-4)
  - Added autonomy level display: tells AI which mode it is in (observe/cautious/moderate/full)
  - Added mode-specific instruction (observe = recommend only, others = auto-execute)
  - Added rules for STALE project prioritization, error retry evaluation, prompt usage
- **Session durations** in `_buildSessionsSection()`: shows `(Nmin running)` instead of `(started ISO)`, with `TIMEOUT IMMINENT` warning when duration >= max
- Commit: `898c8c3`

### Task 2: Add session time boxing scan to the proactive loop
- **`checkSessionTimeouts()` function**: scans all active tmux sessions, compares duration against `maxSessionDurationMs` (default 45min/2700000ms)
- **Timeout handling**: captures last 5 lines of tmux output (best-effort, 300 char limit), calls `sessionManager.stopSession()`, sends notification
- **Notification routing**: uses `notificationManager.notify(msg, 2)` (tier 2 = action needed); falls back to `messenger.send()` if notificationManager unavailable
- **Wired into scan interval**: runs every 60 seconds alongside `proactiveScan()` via combined callback in `setInterval`
- **Logging**: `[TIMEOUT]` log tag for all timeout-related events
- Commit: `2032590`

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| STALE flag skips "complete" status projects | Completed projects are expected idle; flagging them creates noise |
| Error info from both signal files + state | Signal = active error; state = retry history even after signal cleared |
| Timeout scan in same 60s interval as proactiveScan | No extra timer; frequent enough for minute-level precision |
| Timeout notifications at tier 2 | Auto-handled but user needs awareness; not tier 1 since it was resolved |
| Autonomy level read at prompt-build time | Reflects latest runtime override; not stale from boot config |

## Verification Results

- ContextAssembler loads as `function` -- PASS
- All modules load together (commands, ai-brain, context-assembler) -- PASS
- STALE flag present in context-assembler.js -- PASS
- `prompt.*optional` pattern found in response format -- PASS
- `TIMEOUT IMMINENT` present in sessions section -- PASS
- index.js syntax check passes -- PASS
- `checkSessionTimeouts` found as function def and in setInterval -- PASS
- `TIMEOUT` log tag found in index.js -- PASS
- Zero new npm dependencies -- PASS

## Deviations from Plan

None -- plan executed exactly as written.

## Next Phase Readiness

Plan 02-04 (final plan in phase) can proceed. The AI now has:
- Rich staleness and error context for better decision quality
- Expanded response schema for richer recommendations (prompt, confidence, tier)
- Session time boxing as a safety mechanism preventing runaway sessions
- Autonomy-aware prompting that adapts instructions to the current gating level
