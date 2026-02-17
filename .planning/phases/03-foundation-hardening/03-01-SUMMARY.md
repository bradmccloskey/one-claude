# Phase 03 Plan 01: Centralized claude -p Execution Layer

**One-liner:** Centralized `lib/exec.js` wrapper for all `claude -p` calls with semaphore (max 2 concurrent), removed `--dangerously-skip-permissions` from NL handler (FOUND-01 fix)

## Metadata

- **Phase:** 03-foundation-hardening
- **Plan:** 01
- **Completed:** 2026-02-17
- **Duration:** ~2m
- **Tasks:** 2/2

## What Was Built

### lib/exec.js (new file, 177 lines)

Central point for all `claude -p` invocations. Every future feature (structured output, tests, session intelligence) routes through this single module.

**claudeP(prompt, options)** -- synchronous wrapper around `execSync('claude -p ...')`:
- `model` (default: 'sonnet')
- `maxTurns` (default: 1) -- always enforced
- `outputFormat` (default: 'text')
- `jsonSchema` (optional, for Plan 03-03)
- `timeout` (default: 30000ms)
- `allowedTools` (optional, future MCP support)
- NEVER includes `--dangerously-skip-permissions`
- Throws with `.code = 'ETIMEDOUT'` on timeout, `.stderr` on exit errors

**ClaudeSemaphore** -- async concurrency limiter:
- `acquire()` / `release()` with Promise queue
- `active` / `pending` getters for observability
- Singleton `_semaphore` instance (max 2 concurrent)

**claudePWithSemaphore(prompt, options)** -- production async wrapper that acquires a slot before executing claudeP.

### Migrations

**lib/commands.js** -- NL handler (`_handleNaturalLanguage`):
- Replaced raw `execSync('claude -p --model ${model} --output-format text --dangerously-skip-permissions')` with `claudeP(prompt, { model, maxTurns: 1, outputFormat: 'text', timeout: 120000 })`
- Removed `const { execSync } = require('child_process')`
- **Security fix:** `--dangerously-skip-permissions` removed, `--max-turns 1` enforced

**lib/ai-brain.js** -- `think()` and `generateDigest()`:
- Both replaced with `claudeP(prompt, { model, maxTurns: 1, outputFormat: 'text', timeout: 30000 })`
- Removed `const { execSync } = require('child_process')`
- Error handling preserved (compatible error shape)

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| claudeP is synchronous, semaphore is async | execSync blocks the event loop during execution; semaphore gates entry to prevent >2 blocking simultaneously |
| Direct claudeP (not semaphore) for initial migration | Plan 03-03 (structured output) will switch production callers to claudePWithSemaphore |
| session-manager.js `--dangerously-skip-permissions` left intact | That's for interactive `claude` sessions (tmux), not `claude -p` -- different security model |

## Deviations from Plan

None -- plan executed exactly as written.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| f7718f8 | feat | Create lib/exec.js with claudeP() and global semaphore |
| d4a7518 | fix | Migrate all claude -p callers to lib/exec.js, remove dangerous flags |

## Verification Results

| Check | Result |
|-------|--------|
| `grep -rn "dangerously-skip-permissions" lib/` (claude -p paths) | PASS -- none in claude -p code paths |
| `grep -rn "execSync.*claude" lib/` | PASS -- zero results |
| `require('./lib/exec')` loads | PASS |
| Semaphore active=0, pending=0 | PASS |
| `require('./lib/commands')` loads | PASS |
| `require('./lib/ai-brain')` loads | PASS |

## Key Files

### Created
- `lib/exec.js` -- Centralized claude -p execution with semaphore

### Modified
- `lib/commands.js` -- NL handler migrated to claudeP, dangerous flags removed
- `lib/ai-brain.js` -- think() and generateDigest() migrated to claudeP

## Issues Resolved

- **FOUND-01:** NL handler uses `--dangerously-skip-permissions` with no `--max-turns` -- FIXED

## Next Phase Readiness

Plan 03-02 (test infrastructure) can proceed -- exec.js is the primary test target. Plan 03-03 (structured output) will add `--json-schema` support via the `jsonSchema` option already wired into claudeP.
