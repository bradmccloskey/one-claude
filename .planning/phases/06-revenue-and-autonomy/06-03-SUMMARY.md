# Phase 06 Plan 03: Context Assembly & Index Wiring Summary

**One-liner:** Revenue + trust sections wired into AI context and main loop with collection, promotion cron, and graceful shutdown

## Metadata

- **Phase:** 06-revenue-and-autonomy
- **Plan:** 03
- **Subsystem:** context-assembly, orchestrator-main-loop
- **Tags:** context-assembler, index, revenue, trust, wiring, integration
- **Duration:** ~2m
- **Completed:** 2026-02-17

## What Was Done

### Task 1: Add revenue and trust sections to context-assembler.js
- Added `revenueTracker` and `trustTracker` as optional constructor parameters
- Added `_buildRevenueSection()` with null-check guard and try/catch fallback
- Added `_buildTrustSection()` with null-check guard and try/catch fallback
- Inserted revenue (2.8) and trust (2.9) sections between health and priorities in `assemble()`
- Both are fully optional -- backward compatible with existing callers
- **Commit:** `048c0ad`

### Task 2: Wire revenue and trust trackers into index.js
- Added `require` statements for RevenueTracker and TrustTracker
- Initialized both with appropriate dependencies (config, state)
- Passed both to ContextAssembler constructor
- Added `scanCount` variable and conditional `revenueTracker.collect()` every N scans
- Added `trustTracker.update()` on every scan cycle
- Added daily promotion check via `node-cron` at 10 AM (configurable)
- Added Revenue/Trust lines to startup banner
- Added `revenueTracker.close()` and `trustTracker.close()` to shutdown function
- **Commit:** `d2d2c5c`

### Task 3: Update test/helpers.js with new mocks
- Added `revenueTracker` mock with all public methods (collect, getLatest, formatForContext, getWeeklyTrend, close)
- Added `trustTracker` mock with all public methods (update, checkPromotion, formatForContext, getMetrics, resetPromotionFlag, close)
- All existing mocks preserved, backward compatible
- **Commit:** `84b319b`

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

- `context-assembler.js` loads without error
- `_buildRevenueSection` and `_buildTrustSection` both return `null` when trackers not provided
- `index.js` contains RevenueTracker, TrustTracker, collect(), update(), close() calls
- `createMockDeps()` includes both revenueTracker and trustTracker
- All 87 existing tests pass (0 failures)
- No new npm dependencies added (node-cron already in use via scheduler)

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Revenue/trust sections placed between health and priorities | Natural context flow: system state -> revenue -> trust -> priorities |
| promotionJob uses require('node-cron') inline | node-cron already used by Scheduler; avoids adding to top-level require chain |
| scanCount is module-level variable | Persists across scan intervals, reset only on restart |

## Key Files

### Created
- None

### Modified
- `lib/context-assembler.js` -- Added revenueTracker/trustTracker deps, _buildRevenueSection(), _buildTrustSection()
- `index.js` -- Full wiring: require, init, pass to ContextAssembler, scan loop, cron, banner, shutdown
- `test/helpers.js` -- Added revenueTracker and trustTracker mocks to createMockDeps()

## Dependency Graph

- **Requires:** 06-01 (RevenueTracker), 06-02 (TrustTracker)
- **Provides:** Revenue and trust data in AI context, automated collection, daily promotion checks
- **Affects:** 06-04 (revenue dashboard command, if planned)

## Next Phase Readiness

- Revenue data will appear in AI context on next think cycle
- Trust metrics update every 60s scan
- Revenue collection every 5 minutes (5 scans x 60s)
- Promotion checks daily at 10 AM
- Both databases gracefully closed on shutdown
