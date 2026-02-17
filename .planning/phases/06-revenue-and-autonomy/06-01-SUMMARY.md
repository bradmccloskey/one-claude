---
phase: 06-revenue-and-autonomy
plan: 01
subsystem: revenue
tags: [sqlite, better-sqlite3, xmr-mining, supportxmr, coingecko, mlx-api, revenue-tracking]
dependency-graph:
  requires: []
  provides: ["RevenueTracker class with SQLite persistence", "XMR mining + MLX API data collection", "Revenue config in config.json"]
  affects: ["06-03 (context assembly integration)", "06-04 (digest formatting)"]
tech-stack:
  added: []
  patterns: ["lazy SQLite initialization", "NULL vs zero distinction for missing data vs genuine zero", "Promise.allSettled for independent source collection", "periodic pruning with daily gate"]
key-files:
  created: ["lib/revenue-tracker.js"]
  modified: ["config.json", ".gitignore"]
decisions:
  - id: "06-01-D1"
    summary: "Lazy DB initialization"
    context: "RevenueTracker may be constructed but never used if revenue.enabled is false"
    choice: "Lazy init via _ensureDb() -- DB file only created on first access"
    alternatives: ["Eager init in constructor (creates DB even if unused)"]
  - id: "06-01-D2"
    summary: "NULL vs zero distinction"
    context: "When an API is unreachable, storing 0 would be indistinguishable from genuinely zero revenue"
    choice: "NULL means no data (API unreachable), 0 means genuinely zero (API returned zero)"
    alternatives: ["Separate status column", "Skip row entirely on failure"]
metrics:
  duration: "~3m"
  completed: "2026-02-17"
---

# Phase 06 Plan 01: Revenue Tracker SQLite Foundation Summary

**One-liner:** RevenueTracker with lazy SQLite WAL-mode DB, XMR mining (SupportXMR + CoinGecko) and MLX API collection, NULL vs zero distinction, data age tracking, weekly trend queries, and periodic pruning

## What Was Done

### Task 1: lib/revenue-tracker.js (RevenueTracker class)
- **Constructor:** DI pattern with `{ config }`, lazy `this.db = null`, collection timestamps
- **_ensureDb():** Lazy SQLite init at `orchestrator.db`, WAL mode, `revenue_snapshots` table with 10 columns, composite index on `(source, collected_at)`
- **collect():** Main entry point, `Promise.allSettled` for independent XMR + MLX collection, fires `_maybePrune()` after each collection
- **_collectXMR():** Fetches SupportXMR pool stats (`/api/miner/{wallet}/stats`) and CoinGecko price, stores `balance_atomic`, `paid_atomic`, `hashrate`, `xmr_price_usd`, `raw_json` -- NULL for any field that couldn't be fetched
- **_collectMLX():** Fetches MLX `/health` endpoint, stores `requests_served`, `tokens_generated`, `raw_json`
- **getLatest():** Returns most recent snapshot per source with computed `ageMinutes`
- **formatForContext():** Compact multi-line string with per-source data, USD conversion, stale warnings (>1h = STALE)
- **getWeeklyTrend():** Week-over-week comparison (Sunday-to-Sunday), handles counter resets for MLX
- **_maybePrune():** Daily gate, deletes snapshots older than `retentionDays`
- **close():** Graceful DB shutdown

### Task 2: Config and gitignore updates
- **config.json:** Added `revenue` section with `enabled: true`, `collectionIntervalScans: 5` (every 5 minutes), `xmrWallet` address, `retentionDays: 90`
- **.gitignore:** Added `orchestrator.db` to prevent SQLite database from being committed

## Deviations from Plan

None -- plan executed exactly as written.

## Decisions Made

1. **Lazy DB initialization** (06-01-D1): DB file only created on first `_ensureDb()` call, not in constructor. This avoids creating an empty database if revenue tracking is disabled.
2. **NULL vs zero distinction** (06-01-D2): NULL in database means API was unreachable (no data), zero means the API genuinely returned zero. This is critical for accurate revenue reporting vs data availability.

## Commits

| Hash | Message |
|------|---------|
| b6b31d0 | feat(06-01): create RevenueTracker with SQLite persistence |
| 4202bd7 | feat(06-01): add revenue config and gitignore orchestrator.db |

## Next Phase Readiness

Plan 06-01 provides the data foundation. The RevenueTracker can collect and store data independently. Remaining integration:
- 06-03: Wire `formatForContext()` into ContextAssembler for AI brain awareness
- 06-04: Wire `getWeeklyTrend()` into digest formatting for morning summaries
