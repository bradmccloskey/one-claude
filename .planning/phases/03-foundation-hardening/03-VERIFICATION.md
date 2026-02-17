---
phase: 03-foundation-hardening
verified: 2026-02-17T00:00:00Z
status: passed
score: 12/12 must-haves verified
---

# Phase 3: Foundation Hardening Verification Report

**Phase Goal:** The orchestrator is safe, testable, and has reliable structured communication with claude -p -- prerequisites for every v4.0 feature
**Verified:** 2026-02-17
**Status:** PASSED
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | All claude -p invocations go through lib/exec.js, never raw execSync | VERIFIED | No raw `execSync.*claude` in lib/; exec.js is the sole entry point (session-manager.js uses --dangerously-skip-permissions only for launching interactive tmux Claude Code sessions, which is not a claude -p call) |
| 2  | A semaphore limits concurrent claude -p processes to 2; a third caller waits | VERIFIED | ClaudeSemaphore(2) singleton exported from exec.js; test "third acquire waits until release" passes |
| 3  | Sending a natural language SMS never uses --dangerously-skip-permissions | VERIFIED | grep -rn "dangerously-skip-permissions" lib/ shows only a comment in exec.js and the session-manager tmux launch (not a claude -p call); commands.js NL handler uses claudePWithSemaphore with no dangerous flags |
| 4  | The NL handler uses --max-turns 1 so it cannot loop | VERIFIED | commands.js line 649-654: claudePWithSemaphore called with maxTurns: 1, timeout: 120000 |
| 5  | Restarting the daemon preserves conversation history from before the restart | VERIFIED | ConversationStore persists to .conversation-history.json; test "persists messages to disk and loads them back" verifies round-trip survival |
| 6  | Messages older than 24 hours are automatically pruned on load | VERIFIED | ConversationStore._prune() filters entries where ts < now - ttlMs (default 24h); TTL test passes |
| 7  | The conversation store holds at most 20 messages | VERIFIED | maxMessages=20 default; push() and _prune() both cap at maxMessages; cap test passes |
| 8  | Credential-like strings are filtered before storage | VERIFIED | _filterCredentials() redacts sk-, ghp_, sk_live_, xoxb- patterns; all 3 credential test cases pass |
| 9  | The AI does not send the same recommendation SMS twice in observe mode | VERIFIED | formatForSMS() checks _isDuplicate() before including validated recs; returns null when all deduped; dedup test passes |
| 10 | Dedup is content-based (hashes project+action+reason), not timer-based | VERIFIED | _hashRecommendation() builds content string from project:action:reason; _isDuplicate() checks this hash against _recentHashes Map |
| 11 | All AI brain responses are valid JSON matching their schema -- no parseJSON fallback | VERIFIED | THINK_SCHEMA constant defined; claudePWithSemaphore called with jsonSchema: THINK_SCHEMA; JSON.parse used directly; parseJSON() removed (line 367 comment confirms) |
| 12 | Running node --test executes integration tests that all pass | VERIFIED | npm test (node --test test/*.test.js): 16 tests, 16 pass, 0 fail across 4 suites |

**Score:** 12/12 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `lib/exec.js` | Centralized claude -p execution with semaphore | VERIFIED | 177 lines; exports claudeP, claudePWithSemaphore, ClaudeSemaphore, _semaphore; no --dangerously-skip-permissions |
| `lib/conversation-store.js` | Persistent conversation history with TTL, cap, credential filtering | VERIFIED | 150 lines; exports ConversationStore; push/getRecent/getAll/clear all implemented |
| `lib/decision-executor.js` | Content-based dedup in formatForSMS | VERIFIED | _recentHashes Map, _isDuplicate, _hashRecommendation, _recordRecommendation all present |
| `test/helpers.js` | Test utilities: createTempDir, mockClaudeP, createMockDeps | VERIFIED | 83 lines; exports all three helpers |
| `test/exec.test.js` | Tests for semaphore behavior | VERIFIED | 87 lines; 4 tests covering concurrency, waiting, FIFO, exports |
| `test/conversation-store.test.js` | Tests for persistence, TTL, cap, credential filtering | VERIFIED | 114 lines; 5 tests covering all behaviors |
| `test/decision-executor.test.js` | Tests for validation, dedup, TTL expiry | VERIFIED | 142 lines; 7 tests covering evaluate() and formatForSMS() |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `lib/commands.js` | `lib/exec.js` | `const { claudePWithSemaphore } = require('./exec')` | WIRED | Line 1: imported; line 649: used in _handleNaturalLanguage |
| `lib/ai-brain.js` | `lib/exec.js` | `const { claudePWithSemaphore } = require("./exec")` | WIRED | Line 1: imported; lines 99, 324: used in think() and generateDigest() |
| `lib/commands.js` | `lib/conversation-store.js` | `conversationStore` dep injection; push/getRecent calls | WIRED | Lines 24, 620-621, 644-645, 678-679 |
| `lib/decision-executor.js` | dedup hash | `_recentHashes` Map + `_isDuplicate` check | WIRED | formatForSMS() at line 135 checks _isDuplicate before including rec |
| `test/exec.test.js` | `lib/exec.js` | `require('../lib/exec')` | WIRED | Line 5: imports ClaudeSemaphore, claudeP, claudePWithSemaphore, _semaphore |
| `index.js` | `lib/conversation-store.js` | `new ConversationStore()` passed to CommandRouter | WIRED | Lines 17, 68, 82 |
| `route()` callers | `commands.route()` | `await commands.route()` | WIRED | index.js lines 277, 489: both await; route() is async (line 45 of commands.js) |
| context-assembler | response format | Replaced old JSON example with schema enforcement notice | WIRED | "Response format is enforced by JSON schema" at line 378; no "Respond with a JSON object in this exact format" |

### Requirements Coverage

| Requirement | Status | Notes |
|-------------|--------|-------|
| FOUND-01 (exec.js semaphore, no dangerously-skip-permissions) | SATISFIED | exec.js verified; all callers migrated |
| FOUND-02 (semaphore limits to 2, third queues) | SATISFIED | ClaudeSemaphore(2); test confirms third waits |
| FOUND-03 (structured output via --json-schema, no parseJSON) | SATISFIED | THINK_SCHEMA + jsonSchema option; parseJSON removed |
| FOUND-04 (conversation persistence, 24h pruning) | SATISFIED | ConversationStore with file I/O; TTL prune on load |
| FOUND-05 (node --test integration tests pass) | SATISFIED | 16/16 tests pass via npm test |
| FOUND-06 (content-based dedup, not timer-based) | SATISFIED | djb2 hash of project+action+reason; Map-based tracking |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `lib/session-manager.js` line 96 | `--dangerously-skip-permissions` | Info | This is correct usage for launching interactive Claude Code tmux sessions (not claude -p API calls); the plan's requirement was specifically about claude -p invocations, which are now all clean |

No blockers found. The session-manager usage of --dangerously-skip-permissions is intentional and correct -- it runs Claude Code in an interactive tmux session for autonomous project operation, not an API call.

### Human Verification Required

None required. All critical behaviors are verified structurally:
- Semaphore tested with concurrent timing
- Credential filtering tested against actual secret patterns
- Dedup tested with TTL expiry
- Persistence tested with new-instance round-trip

### Summary

All 12 must-haves from Plans 01-04 are verified in the codebase:

**Plan 01 (exec.js):** lib/exec.js exists with 177 lines, exports all required symbols, implements ClaudeSemaphore with max=2. All lib/ callers use claudePWithSemaphore (commands.js, ai-brain.js) or claudeP (none remain using raw execSync). No --dangerously-skip-permissions anywhere in claude -p code paths.

**Plan 02 (conversation + dedup):** ConversationStore persists to .conversation-history.json, prunes on TTL, caps at 20, redacts credentials. DecisionExecutor has _recentHashes Map, _isDuplicate(), _hashRecommendation() based on djb2. formatForSMS() returns null when all recs are deduped. index.js and commands.js both check for null return.

**Plan 03 (structured output):** THINK_SCHEMA constant at module level of ai-brain.js. Both think() and generateDigest() use claudePWithSemaphore. JSON.parse used directly (no multi-stage fallback). Old "Respond with a JSON object in this exact format" removed from context-assembler.js. route() is async; all callers await it.

**Plan 04 (tests):** npm test (node --test test/*.test.js) runs 16 tests across 4 suites with 0 failures. test/helpers.js exports createTempDir, mockClaudeP, createMockDeps. Tests use temp dirs cleaned up in afterEach. No real claude -p calls in any test.

---

_Verified: 2026-02-17_
_Verifier: Claude (gsd-verifier)_
