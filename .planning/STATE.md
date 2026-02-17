# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-16)

**Core value:** ONE Claude to rule all the Claudes -- central AI brain that autonomously manages all Claude Code sessions across ~19 projects on a Mac Mini.
**Current focus:** Phase 03 - Foundation Hardening

## Current Position

Phase: 03 of 07 (Foundation Hardening)
Plan: 1 of 4 in current phase
Status: In progress
Last activity: 2026-02-17 -- Completed 03-01-PLAN.md (centralized exec layer)

Progress: [============..........] 53% (8/15 plans complete)

## Performance Metrics

**Velocity:**
- Total plans completed: 8 (7 v3.0 + 1 v4.0)
- Average duration: ~2m (03-01 only, pre-metrics for earlier)
- Total execution time: N/A

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 3 | N/A | N/A |
| 02 | 4 | N/A | N/A |
| 03 | 1/4 | ~2m | ~2m |

**Recent Trend:**
- 03-01 completed in ~2m (2 tasks, no deviations)
- Trend: Fast

## Accumulated Context

### Decisions

- v3.0: Use `claude -p` (Max plan) instead of Anthropic SDK -- zero cost, zero dependencies
- v3.0: Safety-first -- observe mode before autonomous execution
- v4.0: Zero new npm dependencies constraint (only `better-sqlite3` and `node-cron`)
- v4.0: Hybrid MCP approach -- direct Node.js for simple/frequent, `claude -p --allowedTools` for complex/infrequent
- v4.0: Polling over fs.watch for reliability (macOS fs.watch has known bugs)
- v4.0: Evaluation before autonomy -- cannot earn trust without measuring success
- v4.0: Revenue tracking starts conservative -- do not use as priority input until 2+ weeks stable data

### Known Issues (from v3.0)

- Repetitive AI recommendations (dedup not working in observe mode) -- FOUND-06
- Conversation history lost on restart (in-memory only) -- FOUND-04
- ~~NL handler uses --dangerously-skip-permissions with no --max-turns -- FOUND-01~~ FIXED in 03-01
- No test suite -- FOUND-05
- Only observe mode has been tested in production

### Blockers

- None

### Decisions (v4.0)

- 03-01: claudeP is synchronous (execSync), semaphore gates entry async -- intentional design
- 03-01: Direct claudeP (no semaphore) for initial migration; 03-03 adds semaphore to production callers
- 03-01: session-manager.js --dangerously-skip-permissions left intact (interactive sessions, not claude -p)

## Session Continuity

Last session: 2026-02-17
Stopped at: Completed 03-01-PLAN.md
Resume file: None
