# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-16)

**Core value:** ONE Claude to rule all the Claudes -- central AI brain that autonomously manages all Claude Code sessions across ~19 projects on a Mac Mini.
**Current focus:** Phase 03 - Foundation Hardening

## Current Position

Phase: 03 of 07 (Foundation Hardening)
Plan: 0 of TBD in current phase
Status: Ready to plan
Last activity: 2026-02-17 -- Roadmap created for v4.0 (Phases 03-07)

Progress: [===========...........] 50% (v3.0 complete, v4.0 starting)

## Performance Metrics

**Velocity:**
- Total plans completed: 7 (v3.0)
- Average duration: N/A (pre-metrics tracking)
- Total execution time: N/A

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 3 | N/A | N/A |
| 02 | 4 | N/A | N/A |

**Recent Trend:**
- v3.0 phases completed rapidly (both in one day)
- Trend: Stable

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
- NL handler uses --dangerously-skip-permissions with no --max-turns -- FOUND-01
- No test suite -- FOUND-05
- Only observe mode has been tested in production

### Blockers

- None

## Session Continuity

Last session: 2026-02-17
Stopped at: Roadmap created for v4.0 milestone
Resume file: None
