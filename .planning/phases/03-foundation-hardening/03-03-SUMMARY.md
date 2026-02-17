# Phase 03 Plan 03: Structured Output + Semaphore Wiring Summary

**One-liner:** Replace fragile 3-stage JSON parser with --json-schema constrained decoding and wire all production claude -p callers through semaphore

## What Was Done

### Task 1: Define JSON schemas and migrate ai-brain.js to --json-schema
- Defined `THINK_SCHEMA` constant at module level with full JSON schema for think cycle responses
- Migrated `think()` from `claudeP()` to `await claudePWithSemaphore()` with `jsonSchema: THINK_SCHEMA`
- Migrated `generateDigest()` from `claudeP()` to `await claudePWithSemaphore()` (text output, no schema)
- Replaced multi-strategy `parseJSON()` with direct `JSON.parse()` + safety-net warning
- Removed the entire `parseJSON()` method (3 strategies: direct parse, fence extraction, brace extraction)
- **Commit:** e8b7ed6

### Task 2: Clean up context-assembler.js and wire semaphore to NL handler
- Removed 15-line JSON format example block from `_buildResponseFormat()`, replaced with 3-line schema reference
- Removed "Respond with a JSON object" from preamble (schema enforces format)
- Switched `_handleNaturalLanguage()` from `claudeP` to `claudePWithSemaphore`
- Made `route()` async; both callers (`pollMessages`, readline handler) now `await` it
- **Commit:** 0988886

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Keep JSON.parse safety-net try/catch in think() | Constrained decoding guarantees schema, but defense-in-depth costs nothing |
| Remove preamble "Respond with a JSON object" text | Redundant with --json-schema; wastes tokens |
| Did not touch _handleContextual() NL call | Dead code -- never called from route() when AI is on |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Cleaned "Respond with a JSON object" from preamble**
- **Found during:** Task 2 verification
- **Issue:** `_buildPreamble()` still said "Respond with a JSON object" which is redundant with --json-schema
- **Fix:** Removed the phrase from the preamble string
- **Files modified:** lib/context-assembler.js
- **Commit:** 0988886

## Verification Results

| Check | Result |
|-------|--------|
| `grep parseJSON lib/ai-brain.js` | Only comment remains |
| `grep THINK_SCHEMA lib/ai-brain.js` | Schema defined and used in think() |
| `grep claudePWithSemaphore lib/ai-brain.js` | 3 hits (import, think, digest) |
| `grep claudePWithSemaphore lib/commands.js` | 2 hits (import, NL handler) |
| `grep "async route" lib/commands.js` | route() is async |
| `grep "await commands.route" index.js` | Both callers await |
| `grep "Respond with a JSON object in this exact format"` | Gone |
| All modules load (`node -e "require(...)"`) | Pass |
| No raw execSync claude -p outside exec.js | Confirmed |

## Key Files

### Created
- None

### Modified
- `lib/ai-brain.js` -- THINK_SCHEMA, claudePWithSemaphore, removed parseJSON()
- `lib/context-assembler.js` -- Shortened response format instructions
- `lib/commands.js` -- async route(), claudePWithSemaphore in NL handler
- `index.js` -- await commands.route() in pollMessages and readline

## Metrics

- **Duration:** ~3 minutes
- **Tasks:** 2/2
- **Commits:** 2 (e8b7ed6, 0988886)
- **Lines changed:** +62 / -82 (net -20 lines, cleaner codebase)
- **Completed:** 2026-02-17
