---
phase: 05-infrastructure-monitoring
plan: 01
subsystem: health-monitoring
tags: [health-check, http, tcp, launchctl, docker, context-assembler]
completed: 2026-02-17
duration: ~2m
dependency_graph:
  requires: [04-01]
  provides: [health-monitor-module, health-config, context-health-section]
  affects: [05-02, 05-03, 05-04]
tech_stack:
  added: []
  patterns: [interval-based-polling, parallel-http-sequential-shell, DI-constructor]
key_files:
  created:
    - lib/health-monitor.js
  modified:
    - config.json
    - lib/context-assembler.js
decisions:
  - "HTTP/TCP checks run in parallel via Promise.allSettled; process/docker checks run sequentially after (execSync blocks)"
  - "Any HTTP response (including 4xx/5xx) counts as UP -- only connection/DNS/timeout failure = DOWN"
  - "formatForContext() returns null when no results exist (not an empty string)"
  - "healthMonitor is an optional dependency in ContextAssembler (null check, not required)"
metrics:
  tasks: 3
  commits: 3
  duration: ~2m
---

# Phase 05 Plan 01: Health Monitor Foundation Summary

**HealthMonitor with HTTP/TCP/process/Docker checks, 8-service config registry, AI context integration**

## What Was Done

### Task 1: Create lib/health-monitor.js
Created the HealthMonitor class with four check types:
- **HTTP**: `fetch()` with `AbortController` timeout. Any response (even 404) = UP. Only connection refused, timeout, DNS failure = DOWN.
- **TCP**: `net.createConnection` with timeout wrapper.
- **Process**: `launchctl list <label>` parsing for PID and LastExitStatus.
- **Docker**: `docker ps --format` parsing to detect running vs stopped containers.

Key methods: `checkAll()` (interval-aware, never throws), `getLastResults()`, `formatForContext()`, `getStats()`.

Commit: `cecbd34`

### Task 2: Add health section to config.json
Added 8 services to the health registry:
- 5 HTTP services: income-dashboard (:8060), site-monitor (:8070), mlx-api (:8100), scraping-api (:8002), ssh-terminal (:7681)
- 2 process services: cloudflare-tunnel, xmr-miner (via launchctl)
- 1 Docker group: bandwidth-sharing (9 containers)

Plus configuration: consecutiveFailsBeforeAlert=3, restartBudget maxPerHour=2, correlatedFailureThreshold=3.

Commit: `f0cad1e`

### Task 3: Wire health monitor into context-assembler.js
- Added `healthMonitor` as optional dependency to ContextAssembler constructor
- Added `_buildHealthSection()` method that delegates to `healthMonitor.formatForContext()`
- Health status section appears between resource snapshot (2.5) and user priorities (3) in AI prompt
- Graceful fallback: returns null if no healthMonitor, "data unavailable" if formatForContext throws

Commit: `2ff6808`

## Decisions Made

1. **Parallel HTTP, sequential shell**: HTTP/TCP checks run via `Promise.allSettled` for parallelism; process/docker checks use `execSync` and run sequentially after parallel checks complete.
2. **Any HTTP response = UP**: Even 4xx/5xx responses indicate the service is reachable. Only network-level failures (connection refused, timeout, DNS) count as DOWN.
3. **Null for empty results**: `formatForContext()` returns `null` (not empty string) when no results exist, consistent with the null-check pattern in `assemble()`.
4. **Optional healthMonitor**: ContextAssembler accepts healthMonitor as an optional dependency -- no breaking change to existing callers that don't pass it.

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

All 6 verification checks passed:
- `require('./lib/health-monitor')` loads without error
- `require('./lib/context-assembler')` loads without error
- config.json has 8 services (>= 8 required)
- `checkAll()` runs without throwing on empty service list
- `formatForContext()` returns null with no results
- No new npm dependencies (still only better-sqlite3, node-cron)

## Next Phase Readiness

Plan 05-02 (Alert Routing and Auto-Restart) can proceed immediately. It will:
- Add alert routing logic that uses `consecutiveFails` from health results
- Implement auto-restart via `launchctl kickstart` for process services
- Use the `_restartTimestamps` array and restart budget already stubbed in HealthMonitor
- Wire HealthMonitor into index.js main loop
