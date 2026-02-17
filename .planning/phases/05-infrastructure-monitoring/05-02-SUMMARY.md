---
phase: 05-infrastructure-monitoring
plan: 02
subsystem: health-monitoring
tags: [alert-routing, auto-restart, correlated-failure, restart-budget, autonomy-gating]
completed: 2026-02-17
duration: ~3m
dependency_graph:
  requires: [05-01]
  provides: [health-alert-routing, auto-restart, restart-budget, correlated-failure-detection, health-restart-history]
  affects: [05-03, 05-04]
tech_stack:
  added: []
  patterns: [sliding-window-budget, correlated-failure-detection, post-action-verification]
key_files:
  created: []
  modified: [lib/health-monitor.js, lib/state.js, index.js]
decisions:
  - "Restart notification is tier-2 (ACTION); failure-only alerts are tier-1 (URGENT)"
  - "Only first down Docker container restarted per budget slot (budget-conscious)"
  - "Post-restart verification via setTimeout(30s) -- non-blocking"
  - "Alert only fires at exact threshold crossing (consecutiveFails === 3), not every subsequent failure"
metrics:
  tasks: 2
  commits: 2
  deviations: 0
---

# Phase 05 Plan 02: Alert Routing & Auto-Restart Summary

**One-liner:** Health monitor alert routing with autonomy-gated restarts, 2/hr budget, correlated failure detection, and 30s post-restart verification.

## What Was Done

### Task 1: Alert routing and auto-restart in health-monitor.js
Added 8 new methods to the HealthMonitor class:

- `_processResults()` -- examines all check results after each cycle, routes to alert or restart
- `_handleInfrastructureEvent()` -- 3+ services down simultaneously triggers tier-1 URGENT, no restarts attempted
- `_handleServiceDown()` -- gates restart on autonomy level (moderate+), budget, and restartability
- `_restartService()` -- executes `launchctl kickstart` or `docker restart`, schedules 30s verification
- `_verifyRestart()` -- re-checks after restart; tier-3 if recovered, tier-1 if still down
- `_getAutonomyLevel()` -- reads runtime autonomy from state (safe default: observe)
- `_checkRestartBudget()` -- sliding window: max 2 restarts per hour
- `_isRestartable()` -- checks if service has launchdLabel or docker containers

### Task 2: State persistence and index.js wiring
- **state.js:** Added `logHealthRestart()` and `getRecentHealthRestarts()` methods with 100-entry cap
- **state.js:** Added `healthRestartHistory: []` to default state object
- **index.js:** Import and construct HealthMonitor with config, notificationManager, state
- **index.js:** Pass healthMonitor to ContextAssembler for AI context integration
- **index.js:** Added `healthMonitor.checkAll()` to existing scan interval (60s)
- **index.js:** Added health service count to startup banner

## Safety Gates

1. **Autonomy gating:** Restarts require `moderate` or `full` autonomy level
2. **Restart budget:** Max 2 restarts per hour (sliding window)
3. **Correlated failure:** 3+ services down = infrastructure event, all restarts blocked
4. **Self-exclusion:** `com.claude.orchestrator` is not in the service config
5. **Post-restart verification:** 30s re-check; if still down, escalates to user (tier-1)
6. **Single container:** Only restarts first down Docker container per budget slot

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Alert on exact threshold crossing only | Prevents alert spam -- fires once at 3 consecutive failures, not every subsequent check |
| Restart = tier-2, alert-only = tier-1 | User needs URGENT for failures that WON'T be auto-fixed; restarts are ACTION level |
| Budget tracked in-memory only | Restarts are rare; memory resets on orchestrator restart are acceptable |
| setTimeout for verification | Non-blocking; doesn't tie up the event loop during 30s wait |

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

- `node -e "require('./lib/health-monitor')"` -- loads without error
- `node -e "require('./lib/state')"` -- loads without error
- `node -c index.js` -- passes syntax check
- All 7 new methods verified present on prototypes
- No new npm dependencies

## Next Phase Readiness

Ready for 05-03 (Health Monitor Tests) and 05-04 (Health Context Polish).
