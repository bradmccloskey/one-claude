---
phase: "07"
plan: "02"
subsystem: "conversation-memory"
tags: ["sqlite", "conversation-store", "context-assembler", "memory"]
dependency_graph:
  requires: ["07-01"]
  provides: ["sqlite-conversation-store", "conversation-memory-context", "keyword-search"]
  affects: ["07-03", "07-04"]
tech_stack:
  added: []
  patterns: ["lazy-db-init", "shared-orchestrator-db", "json-migration"]
key_files:
  created: []
  modified:
    - "lib/conversation-store.js"
    - "lib/context-assembler.js"
    - "index.js"
    - "test/conversation-store.test.js"
decisions:
  - id: "07-02-01"
    description: "SQLite LIKE over FTS5 for search (100 rows makes FTS5 overkill)"
  - id: "07-02-02"
    description: "Conversation section placed after trust section in context assembly order"
  - id: "07-02-03"
    description: "Last 6 entries shown as previews (80-char truncation) with age in context"
  - id: "07-02-04"
    description: "JSON migration uses transaction for atomicity, best-effort (no crash on malformed)"
metrics:
  duration: "~3m"
  completed: "2026-02-17"
---

# Phase 07 Plan 02: Conversation Memory Summary

SQLite-backed conversation store with 100-message cap, 7-day TTL, keyword search, and AI context integration via shared orchestrator.db.

## What Was Done

### Task 1: Rewrite ConversationStore with SQLite Backend
- Replaced JSON file persistence with SQLite via better-sqlite3
- Lazy `_ensureDb()` pattern matching RevenueTracker (shared orchestrator.db)
- 100 message cap (up from 20), 7-day TTL (up from 24h)
- New `search(query)` method for case-insensitive LIKE search (max 20 results)
- New `close()` method for graceful DB shutdown
- JSON migration on first run: reads `.conversation-history.json`, inserts into SQLite via transaction, deletes JSON file
- `_filterCredentials()` preserved exactly as original (same regex patterns)
- Backward-compatible API: `push()`, `getRecent()`, `getAll()`, `clear()` signatures unchanged
- Constructor accepts `{ dbPath, maxMessages, ttlMs }` (dbPath replaces filePath)

### Task 2: Add Conversation Memory to ContextAssembler + Wire index.js
- ContextAssembler accepts optional `conversationStore` in constructor
- `_buildConversationSection()` shows last 6 entries as previews with age
- Format: `Conversation Memory (N exchanges, 7-day window):`
- Each line: `- [role] preview text... (age)` with 80-char truncation
- `_formatConversationAge()` helper: just now / Nm ago / Nh ago / Nd ago
- index.js: moved `conversationStore` initialization before `contextAssembler`
- index.js: passed `conversationStore` to `ContextAssembler` constructor
- index.js: added `conversationStore.close()` to graceful shutdown
- Updated tests for SQLite backend (8 tests, all pass)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated existing tests for SQLite API**
- **Found during:** Task 2
- **Issue:** Existing conversation-store.test.js used old `filePath` constructor parameter and shared the default orchestrator.db, causing cross-test contamination
- **Fix:** Updated all tests to use `dbPath` with isolated temp directories, added `store.close()` in afterEach, added new tests for `search()`, `getRecent()` ordering, and `close()`/reopen
- **Files modified:** test/conversation-store.test.js
- **Commit:** 082c20c

## Decisions Made

1. **SQLite LIKE over FTS5** - For 100 rows, LIKE with `%query%` is perfectly fast and adds zero complexity vs FTS5 virtual tables
2. **Context placement** - Conversation memory placed after trust section (section 2.95), before user priorities
3. **Preview format** - Last 6 entries with 80-char truncation and relative age (e.g., "2h ago")
4. **JSON migration** - Uses SQLite transaction for atomicity, wrapped in try/catch for best-effort (won't crash on malformed JSON)

## Verification

- `node -e "require('./lib/conversation-store')"` -- loads without error
- `node -e "require('./lib/context-assembler')"` -- loads without error
- All 6 public methods verified: push, getRecent, getAll, search, clear, close
- TTL is 7 days (604800000ms), maxMessages is 100
- ContextAssembler includes conversation memory section when data exists
- Returns null when no conversationStore or empty history
- No new npm dependencies added
- All 137 tests pass (8 conversation-store + 129 existing)

## Next Phase Readiness

- ConversationStore SQLite backend ready for 07-03 (learning/preferences)
- Keyword search available for AI to query past conversations
- Context assembler shows conversation history in AI think cycles
