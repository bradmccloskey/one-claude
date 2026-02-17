# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-16)

**Core value:** ONE Claude to rule all the Claudes -- central AI brain that autonomously manages all Claude Code sessions across ~19 projects on a Mac Mini.
**Current focus:** Phase 03 - Foundation Hardening

## Current Position

Phase: 03 of 07 (Foundation Hardening)
Plan: 2 of 4 in current phase
Status: In progress
Last activity: 2026-02-17 -- Completed 03-02-PLAN.md (conversation persistence + dedup)

Progress: [=============.........] 60% (9/15 plans complete)

## Performance Metrics

**Velocity:**
- Total plans completed: 9 (7 v3.0 + 2 v4.0)
- Average duration: ~4m (v4.0 plans)
- Total execution time: N/A

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 3 | N/A | N/A |
| 02 | 4 | N/A | N/A |
| 03 | 2/4 | ~8m | ~4m |

**Recent Trend:**
- 03-01 completed in ~2m (2 tasks, no deviations)
- 03-02 completed in ~6m (2 tasks, no deviations)
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

- ~~Repetitive AI recommendations (dedup not working in observe mode) -- FOUND-06~~ FIXED in 03-02
- ~~Conversation history lost on restart (in-memory only) -- FOUND-04~~ FIXED in 03-02
- ~~NL handler uses --dangerously-skip-permissions with no --max-turns -- FOUND-01~~ FIXED in 03-01
- No test suite -- FOUND-05
- Only observe mode has been tested in production

### Blockers

- None

### Decisions (v4.0)

- 03-01: claudeP is synchronous (execSync), semaphore gates entry async -- intentional design
- 03-01: Direct claudeP (no semaphore) for initial migration; 03-03 adds semaphore to production callers
- 03-01: session-manager.js --dangerously-skip-permissions left intact (interactive sessions, not claude -p)
- 03-02: Synchronous file I/O for ConversationStore (matches state.js pattern)
- 03-02: djb2 hash for dedup (no crypto dependency needed)
- 03-02: 1-hour dedup TTL, in-memory only (resets on restart, acceptable tradeoff)
- 03-02: formatForSMS returns null when all recommendations deduped

## Session Continuity

Last session: 2026-02-17
Stopped at: Completed 03-02-PLAN.md
Resume file: None
