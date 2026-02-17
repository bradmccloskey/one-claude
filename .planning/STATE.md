# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-16)

**Core value:** ONE Claude to rule all the Claudes -- central AI brain that autonomously manages all Claude Code sessions across ~19 projects on a Mac Mini.
**Current focus:** Phase 06 in progress -- Revenue & Autonomy

## Current Position

Phase: 06 of 07 (Revenue & Autonomy)
Plan: 3 of 4 in current phase
Status: In progress
Last activity: 2026-02-17 -- Completed 06-03-PLAN.md (Context Assembly & Index Wiring)

Progress: [███████████████████████░] 96% (23/24 plans complete)

## Performance Metrics

**Velocity:**
- Total plans completed: 23 (7 v3.0 + 16 v4.0)
- Average duration: ~3m (v4.0 plans)
- Total execution time: N/A

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 3 | N/A | N/A |
| 02 | 4 | N/A | N/A |
| 03 | 4/4 | ~14m | ~4m |
| 04 | 5/5 | ~12m | ~2.4m |
| 05 | 4/4 | ~12m | ~3m |
| 06 | 3/4 | ~8m | ~3m |

**Recent Trend:**
- 03-01 completed in ~2m (2 tasks, no deviations)
- 03-02 completed in ~6m (2 tasks, no deviations)
- 03-03 completed in ~3m (2 tasks, 1 minor deviation)
- 03-04 completed in ~3m (2 tasks, 1 minor deviation)
- 04-01 completed in ~3m (2 tasks, no deviations)
- 04-02 completed in ~2m (2 tasks, no deviations)
- 04-03 completed in ~1m (2 tasks, no deviations)
- 04-04 completed in ~4m (2 tasks, no deviations)
- 04-05 completed in ~2m (2 tasks, no deviations)
- 05-01 completed in ~2m (3 tasks, no deviations)
- 05-02 completed in ~3m (2 tasks, no deviations)
- 05-03 completed in ~2m (2 tasks, no deviations)
- 05-04 completed in ~5m (2 tasks, 1 deviation: module cache clearing for execSync)
- 06-01 completed in ~3m (2 tasks, no deviations)
- 06-02 completed in ~3m (2 tasks, config.json already committed by parallel 06-01)
- 06-03 completed in ~2m (3 tasks, no deviations)
- Trend: Phase 06 in progress. 23/24 plans done.

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
- ~~Fragile 3-stage JSON parser in AI brain -- FOUND-03~~ FIXED in 03-03
- ~~No test suite -- FOUND-05~~ FIXED in 03-04
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
- 03-03: Keep JSON.parse safety-net despite --json-schema (defense in depth, zero cost)
- 03-03: _handleContextual() NL call is dead code -- not touched
- 03-04: node:test built-in runner (no Jest/Mocha -- zero dependency constraint)
- 03-04: Glob pattern test/*.test.js required for Node v25 (bare directory form fails)
- 03-04: Test semaphore as pure async logic, not via child_process mocking

### Decisions (Phase 04)

- 04-01: GitTracker is stateless (no constructor deps) -- pure query module, callers persist results
- 04-01: lastIndexOf for pipe-split in commit parsing -- handles commit messages containing `|`
- 04-01: Disk usage null fallback in ResourceMonitor -- df may fail on some systems
- 04-03: Empty catch blocks for headBefore/evalFile -- graceful degradation over hard failure
- 04-03: Prepend eval context to resume prompts (most actionable info first)
- 04-04: evaluateSession() is fire-and-forget (non-blocking) in timeout and scan loops
- 04-04: Duplicate evaluation guard uses timestamp comparison (evaluatedAt > startedAt)
- 04-05: Module cache patching for mocking exec.claudePWithSemaphore in tests (restored in afterEach)

### Decisions (Phase 06)

- 06-01: Lazy DB initialization -- orchestrator.db only created on first _ensureDb() call, not in constructor
- 06-01: NULL vs zero distinction -- NULL means API unreachable (no data), zero means genuinely zero revenue
- 06-02: TrustTracker shares orchestrator.db with RevenueTracker via lazy init
- 06-02: observe->cautious never automated (policy decision, human-only)
- 06-02: checkPromotion() returns recommendation string, never calls setAutonomyLevel()
- 06-02: _promotionSent flag prevents duplicate SMS at same level (resets on level change)
- 06-03: Revenue/trust sections placed between health and priorities (natural context flow)
- 06-03: promotionJob uses inline require('node-cron') (already used by Scheduler)
- 06-03: scanCount is module-level variable, persists across intervals, resets on restart

### Decisions (Phase 05)

- 05-01: HTTP/TCP checks parallel via Promise.allSettled; process/docker sequential (execSync blocks)
- 05-01: Any HTTP response (including 4xx/5xx) = UP; only connection/DNS/timeout = DOWN
- 05-01: formatForContext() returns null (not empty string) when no results exist
- 05-01: healthMonitor is optional dependency in ContextAssembler (null check, backward compatible)
- 05-02: Restart notification is tier-2 (ACTION); failure-only alerts are tier-1 (URGENT)
- 05-02: Only first down Docker container restarted per budget slot (budget-conscious)
- 05-02: Post-restart verification via setTimeout(30s) -- non-blocking
- 05-02: Alert fires at exact threshold crossing only (consecutiveFails === 3), not every subsequent failure
- 05-03: Circuit breaker per MCP server name, not per tool (server-level granularity matches failure patterns)
- 05-03: queryMCP checks breakers BEFORE acquiring semaphore (no wasted slots)
- 05-03: Unknown MCP servers assumed available (forward compatible, no breaker created)
- 05-04: Module cache clearing for execSync patching (health-monitor.js destructures at load time)

## Session Continuity

Last session: 2026-02-17
Stopped at: Completed 06-03-PLAN.md (Context Assembly & Index Wiring)
Resume file: None
