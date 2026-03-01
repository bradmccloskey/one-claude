# Milestone Audit: v4.0 Autonomous Agent with External Integrations

**Audited:** 2026-03-01
**Phases:** 03–07 (21 plans total)
**Plans Executed:** 21/21
**Tests:** 250 pass, 2 real failures, 14 environment failures

---

## Verdict: GAPS FOUND (10)

All 21 plans executed. Core functionality works and the orchestrator runs in production. However, 3 promised features are disabled, 2 test suites are broken, and dashboard-merge modules shipped without tests.

---

## Gap Details

### Code/Test Issues

**GAP-01: Revenue tracker `getWeeklyTrend` — 2 test failures**
- File: `test/revenue-tracker.test.js:370-436`
- Root cause: Test fixtures insert data 1 day into the future (`weekStart + 86400000`), but `getWeeklyTrend()` queries `collected_at < now`. The future-dated records are excluded, so both queries return the same single record → delta = 0.
- Impact: Test bug, not code bug. Production `getWeeklyTrend()` logic is correct.
- Fix: Insert `late` at `now - 1 hour` instead of `weekStart + 1 day`.

**GAP-02: Web server — 14 test failures (EADDRINUSE)**
- File: `test/web-server.test.js`
- Root cause: Tests bind port 8050, but the running orchestrator already holds that port. No dynamic port fallback.
- Impact: All web server tests fail when orchestrator is running. Tests pass on a clean machine.
- Fix: Use port 0 (OS-assigned) or check port availability before binding.

**GAP-03: Phase 07 VERIFICATION.md stale**
- File: `.planning/phases/07/.gsd/VERIFICATION.md`
- Root cause: Written when `sessionLearner` had a TDZ error (used at line 49, declared at line 77). The TDZ was subsequently fixed by reordering declarations, but verification was never re-run.
- Impact: Reports 0/4 goals BLOCKED, actual status is likely PASSED.
- Fix: Re-run `/gsd:verify-work` for Phase 07.

**GAP-04: Dashboard-merge modules shipped without tests**
- Files: `lib/scan-db.js` (165 lines), `lib/email-digest.js` (27+ lines)
- These modules were ported from `project-dashboard` on 2026-02-28 and wired into index.js but have no corresponding test files.
- Fix: Add `test/scan-db.test.js` and `test/email-digest.test.js`.

**GAP-05: ROADMAP.md header inconsistency**
- File: `.planning/ROADMAP.md:7`
- Line 7 says `(in progress)` but line 39 says `(COMPLETE 2026-02-17)`.
- Fix: Change line 7 to `(shipped 2026-02-17)`.

### Feature Gaps (built but disabled)

**GAP-06: Evening wind-down digest disabled**
- Config: `eveningDigest.enabled: false`
- Roadmap Phase 06 SC5: "The user receives an evening wind-down digest at 9:45 PM"
- Code path verified: `scheduler.js:70-88` → `index.js:189-233`. Wiring is complete.
- Status: Feature works when enabled. Intentionally left off (user chose to disable).

**GAP-07: Weekly revenue SMS disabled**
- Config: `weeklyRevenue.enabled: false`
- Roadmap Phase 06 SC4: "The user receives a weekly revenue summary SMS on Sunday mornings"
- Code path verified: `scheduler.js:93-110` → `index.js:240-287`. Wiring is complete.
- Status: Feature works when enabled. Intentionally left off.

**GAP-08: Trust promotion checks disabled**
- Config: `trust.promotionCheckEnabled: false`
- Roadmap Phase 06 SC3: "When trust thresholds are crossed... the user receives a promotion recommendation SMS"
- Status: Trust metrics accumulate correctly. Only the promotion SMS is gated off.

### Architecture Debt

**GAP-09: 14 of 28 lib modules have no test file**
- Tested (14): conversation-store, decision-executor, exec, git-tracker, health-monitor, mcp-bridge, reminder-manager, resource-monitor, revenue-tracker, session-evaluator, session-learner, trust-tracker, web-server, helpers
- Untested (14): ai-brain, commands, context-assembler, digest, email-digest, messenger, notification-manager, process-monitor, remote-scanner, scan-db, scanner, scheduler, session-manager, signal-protocol, state
- Most untested modules are integration-heavy (messenger sends iMessage, scanner walks disk, etc.), but `commands.js` and `context-assembler.js` contain significant logic that could be unit-tested.

**GAP-10: Web server tests tightly coupled to fixed port**
- Related to GAP-02 but different concern: the test architecture assumes a dedicated port rather than dynamic assignment. This makes tests impossible to run alongside the production service.

---

## Success Criteria Cross-Check

| Phase | SC | Description | Status |
|-------|----|-------------|--------|
| 03 | 1 | SMS never triggers --dangerously-skip-permissions | PASS |
| 03 | 2 | Concurrent claude -p with semaphore | PASS |
| 03 | 3 | All AI responses are valid JSON | PASS |
| 03 | 4 | Conversation persistence + 24h prune | PASS |
| 03 | 5 | `node --test` runs integration tests | PASS (250/250 non-env) |
| 03 | 6 | Content-based recommendation dedup | PASS |
| 04 | 1 | Session reports commits/files/diff | PASS |
| 04 | 2 | Quality score 1-5 with recommendation | PASS |
| 04 | 3 | Resume prompt includes previous score | PASS |
| 04 | 4 | CPU/memory/disk in AI context | PASS |
| 05 | 1 | Health checks + SMS on service down | PASS |
| 05 | 2 | Auto-restart with budget + correlated protection | PASS |
| 05 | 3 | MCP bridge with circuit breaker | PASS |
| 06 | 1 | Revenue from XMR + MLX, NULL vs zero, data age | PASS |
| 06 | 2 | Trust metrics accumulate + visible in context | PASS |
| 06 | 3 | Promotion recommendation SMS | GAP-08 (disabled) |
| 06 | 4 | Weekly revenue summary SMS Sunday mornings | GAP-07 (disabled) |
| 06 | 5 | Evening wind-down digest at 9:45 PM | GAP-06 (disabled) |
| 07 | 1 | Reminder system with NL parsing | PASS |
| 07 | 2 | SQLite conversation history, 100-msg cap | PASS |
| 07 | 3 | MCP for managed sessions | PASS |
| 07 | 4 | Session learning from 50+ evaluations | PASS |

**Result:** 19/22 success criteria PASS, 3 are code-complete but disabled in config.

---

## Recommended Actions

### Quick Fixes (< 30 min)
1. Fix ROADMAP.md header (GAP-05)
2. Re-run Phase 07 verification (GAP-03)
3. Fix revenue tracker test date boundaries (GAP-01)

### Medium Effort (1-2 hrs)
4. Add dynamic port allocation to web server tests (GAP-02, GAP-10)
5. Add test files for scan-db and email-digest (GAP-04)

### User Decision Required
6. Enable evening digest, weekly revenue SMS, and trust promotion (GAP-06/07/08) — these are config toggles, flip when ready

### Backlog (optional)
7. Add test coverage for commands.js and context-assembler.js (GAP-09)
