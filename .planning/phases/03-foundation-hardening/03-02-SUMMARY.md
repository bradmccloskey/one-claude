# Phase 03 Plan 02: Conversation Persistence and Recommendation Dedup

**One-liner:** File-backed ConversationStore with 24h TTL, 20-message cap, credential redaction, plus content-based djb2 dedup for AI recommendations (fixes FOUND-04 and FOUND-06)

## Metadata

- **Phase:** 03-foundation-hardening
- **Plan:** 02
- **Completed:** 2026-02-17
- **Duration:** ~6m
- **Tasks:** 2/2

## What Was Built

### lib/conversation-store.js (new file, 131 lines)

Persistent conversation history that survives daemon restarts. Replaces the in-memory `_conversationHistory` array in commands.js.

**ConversationStore class:**
- Constructor takes `{ filePath, maxMessages, ttlMs }` with sensible defaults
- `push(entry)` -- adds `{ role, text, ts }` entry with credential filtering, auto-caps at maxMessages
- `getRecent(count)` -- loads, prunes expired (>24h), returns last N entries
- `getAll()` -- loads, prunes, returns full array
- `clear()` -- writes empty array
- `_filterCredentials(text)` -- redacts OpenAI keys (sk-), Stripe keys (sk_live_), GitHub PATs (ghp_), Slack tokens (xoxb-), and generic key/token/Bearer contexts
- File I/O via synchronous `readFileSync`/`writeFileSync` (same pattern as state.js)

### Content-Based Recommendation Dedup (decision-executor.js)

Prevents the same AI recommendation from being sent via SMS repeatedly in observe mode.

- `_recentHashes` Map with 1-hour TTL (configurable via `config.ai.dedupTtlMs`)
- `_hashRecommendation(rec)` -- djb2 hash of `project:action:reason` (lowercase, first 100 chars of reason)
- `_isDuplicate(rec)` -- checks hash map, returns true if seen within TTL
- `_recordRecommendation(rec)` -- stores hash with timestamp, prunes expired entries
- `formatForSMS()` now filters validated recommendations through dedup before formatting
- Returns `null` when all recommendations were duplicates (callers skip SMS)

### Wiring Changes

**commands.js:**
- Replaced `this._conversationHistory = []` with `this.conversationStore = deps.conversationStore || null`
- All three conversation history touchpoints migrated to `conversationStore.push()` / `conversationStore.getRecent()`
- Removed manual trim logic (`if length > 10, slice(-10)`)
- `_handleAiThink()` handles null from formatForSMS with informative message

**index.js:**
- Imports ConversationStore, creates instance, passes to CommandRouter
- Think cycle checks for null return from formatForSMS before notifying

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Synchronous file I/O for ConversationStore | Matches existing state.js pattern; conversation ops are infrequent and fast |
| djb2 hash instead of crypto | Zero dependency, fast, sufficient for dedup (not security-critical) |
| 1-hour dedup TTL (not persistent) | In-memory Map resets on restart, which is acceptable -- stale dedup state is worse than re-sending once |
| formatForSMS returns null for all-deduped | Cleanest API -- callers decide what to do with no-op result |
| ConversationStore falls back gracefully | If deps.conversationStore is null, commands.js still works (empty history) |

## Deviations from Plan

None -- plan executed exactly as written.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| 9e8e5f1 | feat | Create lib/conversation-store.js, wire into commands.js and index.js |
| 3de9c9d | feat | Add content-based recommendation dedup to decision-executor.js |

## Verification Results

| Check | Result |
|-------|--------|
| `require('./lib/conversation-store')` loads | PASS |
| Credential filtering (sk- key redacted) | PASS |
| Message cap (5 pushed, 3 max = 3 stored) | PASS |
| Persistence survives re-instantiation | PASS |
| `grep _conversationHistory lib/commands.js` | PASS -- zero results |
| `_isDuplicate` / `_hashRecommendation` exist | PASS |
| formatForSMS returns SMS first call, null second call | PASS |
| `require('./lib/commands')` loads | PASS |

## Key Files

### Created
- `lib/conversation-store.js` -- Persistent conversation store with TTL, cap, and credential filtering

### Modified
- `lib/commands.js` -- Migrated from in-memory array to ConversationStore, null-check on formatForSMS
- `lib/decision-executor.js` -- Added content-based dedup with djb2 hash and 1-hour TTL
- `index.js` -- Added ConversationStore import/instantiation, null-check on formatForSMS

## Issues Resolved

- **FOUND-04:** Conversation history lost on restart (in-memory only) -- FIXED with file-backed ConversationStore
- **FOUND-06:** Repetitive AI recommendations in observe mode -- FIXED with content-based dedup

## Next Phase Readiness

Plan 03-03 (structured output) can proceed. Plan 03-04 (test infrastructure) can now test ConversationStore and dedup logic as primary targets alongside exec.js.
