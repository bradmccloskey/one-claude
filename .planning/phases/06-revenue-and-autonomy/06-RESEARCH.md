# Phase 06 Research: Revenue & Autonomy

**Phase:** 06 - Revenue & Autonomy
**Researched:** 2026-02-17
**Objective:** What do I need to know to PLAN this phase well?

---

## 1. Requirements Recap

| Req | Summary | Key Constraint |
|-----|---------|----------------|
| REV-01 | Revenue tracker: XMR mining API + MLX access logs, SQLite snapshots, NULL vs zero distinction, data age tracking | Zero new npm dependencies (better-sqlite3 already installed) |
| REV-02 | Trust metrics: per-autonomy-level stats (sessions launched, avg eval score, false alert rate, days at level) visible in AI context | Depends on Phase 04 evaluationHistory |
| REV-03 | Autonomy promotion recommendations via SMS when trust thresholds crossed (30+ sessions at cautious, avg score >= 3.5) -- never self-promotes | User must always confirm via `ai level` command |
| REV-04 | Weekly revenue summary SMS on Sunday mornings, per-source breakdown, week-over-week trends | node-cron for scheduling, fits within 20 SMS/day budget |
| REV-05 | Evening wind-down digest at 9:45 PM: day's session accomplishments, commits across projects, tomorrow's plan | Before quiet hours (22:00), can reuse AI digest pattern |

---

## 2. Revenue Data Sources (Verified on Machine)

### 2a. XMR Mining (SupportXMR Pool API)

**Pool:** supportxmr.com
**Wallet:** `45c7vD9rqJyBRX6CMHp4kJAUcB8zZBmKQTkX6KHLcJeXaiDLoLW6NzXYjwHbkWwJuo6zmcoVKTrtAfnVNnyHMgm3P7a4LQD`
**API endpoint:** `https://www.supportxmr.com/api/miner/<wallet>/stats`

**Live response (verified 2026-02-17):**
```json
{
    "hash": 2592,
    "identifier": "global",
    "lastHash": 1771348208,
    "totalHashes": 799793610,
    "validShares": 5048,
    "invalidShares": 0,
    "expiry": 1771348268649,
    "amtPaid": 0,
    "amtDue": 629305994,
    "txnCount": 0
}
```

**Key fields:**
- `amtDue` -- unpaid balance in atomic units (1 XMR = 1e12 atomic units). Currently: 0.000629 XMR
- `amtPaid` -- total XMR paid out (currently 0 -- below min payout threshold)
- `hash` -- current pool-side hashrate in H/s
- `validShares`, `invalidShares` -- share counters (useful for quality tracking)
- `totalHashes` -- all-time hash count

**XMR price API:** `https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd`
- Live: `{"monero":{"usd":329.98}}`
- CoinGecko free tier: 10-30 req/min, no auth needed for simple/price

**Revenue calculation:**
- Balance in XMR = amtDue / 1e12
- Balance in USD = balance_xmr * xmr_usd_price
- Total earned (all-time) = (amtDue + amtPaid) / 1e12

**NULL vs zero distinction for REV-01:**
- `amtDue = 0` means truly zero balance (paid out or never earned)
- API failure / network error = NULL (no data available, different from zero)
- This is critical: store NULL when fetch fails, store 0 when API returns 0

**Existing daily-report.sh:** Already has the complete fetch + parse + USD conversion logic in bash. This phase moves it to Node.js in the orchestrator.

**Collection approach:** HTTP fetch from Node.js using native `fetch()` (available in Node 18+). No curl needed. Both APIs are unauthenticated GET requests.

### 2b. MLX Inference API

**Location:** `/Users/claude/projects/passive/mlx-inference-api/`
**Port:** 8100 (localhost)
**Health endpoint:** `GET http://localhost:8100/health`

**Live response (verified 2026-02-17):**
```json
{
    "status": "ok",
    "model": "mlx-community/Qwen2.5-7B-Instruct-4bit",
    "requests_served": 0,
    "total_tokens_generated": 0,
    "avg_generation_tps": 0.0,
    "peak_memory_gb": 0.0
}
```

**Key fields:**
- `requests_served` -- total requests since last restart (in-memory counter, resets on restart)
- `total_tokens_generated` -- cumulative token count since restart

**Revenue data challenge:**
The MLX API has NO persistent access logging. The `requests_served` counter is in-memory only and resets when the service restarts. There is no revenue data per se -- revenue comes from RapidAPI subscribers, and that data lives on the RapidAPI dashboard (external), not locally.

**What we CAN collect locally:**
1. **Request count from /health endpoint** -- snapshot at each collection interval. Since it resets on restart, we need to detect resets (new value < previous value means restart occurred).
2. **Uvicorn stdout.log** -- contains HTTP access logs like `INFO: 64.99.201.13:0 - "POST /v1/chat/completions HTTP/1.1" 200 OK`. We could parse these for request counts per IP, but most are health checks from the orchestrator itself (port 127.0.0.1) or Cloudflare tunnel (64.99.201.13).
3. **Revenue attribution:** For now, MLX revenue = 0 (no confirmed RapidAPI subscribers yet). The PRO and ULTRA tiers ($29/$99/mo) have not been activated on the Monetize tab.

**Recommended approach for MLX:**
- Poll `/health` endpoint periodically (every 5 minutes) to get `requests_served`
- Store snapshot in SQLite with NULL if endpoint unreachable, 0 if truly zero
- Track `external_requests` by parsing stdout.log for POST /v1/chat/completions from non-127.0.0.1 IPs (low priority -- can be deferred)
- Revenue = $0 until RapidAPI subscriptions are activated (store as NULL, not 0)

### 2c. Bandwidth Sharing (Docker Containers)

**Location:** `/Users/claude/projects/passive/bandwidth-sharing/`
**Containers:** 9 sharing containers + watchtower (10 total)

**Revenue data:** No local API for any bandwidth service. All revenue dashboards are web-only:
- Honeygain: dashboard.honeygain.com
- EarnApp: earnapp.com/dashboard
- Pawns: dashboard.pawns.app

**Recommendation:** Exclude from REV-01 (local sources only). The requirements document explicitly says "Revenue tracking from platform APIs (RapidAPI GraphQL, Apify API, bandwidth service dashboards) -- deferred until local sources are proven stable." Bandwidth sharing revenue should be manual entry only or deferred to a future phase.

### 2d. Revenue Source Summary

| Source | Data Available Locally | Collection Method | Revenue Precision |
|--------|----------------------|-------------------|-------------------|
| XMR Mining | Balance, hashrate, shares | HTTP API (SupportXMR + CoinGecko) | Exact (atomic units + price) |
| MLX API | Request count, tokens | HTTP /health endpoint + log parsing | Proxy only (no $/request data) |
| Bandwidth | None | N/A (web dashboards only) | Deferred |
| Web Scraping | None | N/A (RapidAPI/Apify dashboards) | Deferred |

**Conservative approach (per prior decision):** Only XMR has real revenue data. MLX should track usage metrics (requests, tokens) but mark revenue as NULL until subscription revenue is confirmed. Do not use revenue data as priority input until 2+ weeks stable data.

---

## 3. SQLite Schema Design

### 3a. Existing SQLite Usage

The orchestrator uses `better-sqlite3` only for reading the macOS Messages database (in `messenger.js`). There is no orchestrator-owned SQLite database yet. All state is stored in `.state.json` (JSON file).

**This phase creates the first orchestrator-owned SQLite database.**

### 3b. Proposed Tables

**`revenue_snapshots` -- REV-01**
```sql
CREATE TABLE revenue_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,           -- 'xmr-mining' | 'mlx-api'
  collected_at TEXT NOT NULL,     -- ISO 8601 timestamp
  balance_atomic INTEGER,         -- XMR: amtDue in atomic units (NULL if fetch failed)
  paid_atomic INTEGER,            -- XMR: amtPaid in atomic units (NULL if fetch failed)
  hashrate REAL,                  -- XMR: H/s from pool (NULL if fetch failed)
  xmr_price_usd REAL,            -- XMR price at collection time (NULL if fetch failed)
  requests_served INTEGER,        -- MLX: total requests (NULL if unreachable)
  tokens_generated INTEGER,       -- MLX: total tokens (NULL if unreachable)
  raw_json TEXT                   -- Full API response for debugging (first 2 weeks)
);
CREATE INDEX idx_revenue_source_time ON revenue_snapshots(source, collected_at);
```

**NULL vs zero semantics:**
- `balance_atomic = NULL` -- API was unreachable, no data available
- `balance_atomic = 0` -- API responded, balance is genuinely zero
- This allows queries like `WHERE balance_atomic IS NOT NULL` to distinguish "we checked" from "we couldn't check"

**Data age tracking:**
- `collected_at` stores when the snapshot was taken
- ContextAssembler shows "XMR balance: $0.21 (12min ago)" using `collected_at` vs now
- Stale data warning if last successful collection > 1 hour ago

**`trust_metrics` -- REV-02**
```sql
CREATE TABLE trust_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  autonomy_level TEXT NOT NULL,     -- 'observe' | 'cautious' | 'moderate' | 'full'
  entered_at TEXT NOT NULL,         -- When this level was entered
  exited_at TEXT,                   -- When this level was exited (NULL = current)
  sessions_launched INTEGER DEFAULT 0,
  avg_eval_score REAL,              -- Running average of SessionEvaluator scores
  total_evaluations INTEGER DEFAULT 0,
  false_alerts INTEGER DEFAULT 0,   -- Notifications that didn't need action
  true_alerts INTEGER DEFAULT 0,    -- Notifications that were actionable
  days_at_level REAL DEFAULT 0      -- Calculated: (exited_at - entered_at) in days
);
CREATE INDEX idx_trust_level ON trust_metrics(autonomy_level, exited_at);
```

**Alternative: Single-row approach**
Since there are only 4 autonomy levels and transitions are rare, a simpler approach is a single JSON object in state or a 4-row table:

```sql
CREATE TABLE trust_summary (
  autonomy_level TEXT PRIMARY KEY,
  total_sessions INTEGER DEFAULT 0,
  total_evaluations INTEGER DEFAULT 0,
  sum_eval_scores REAL DEFAULT 0,      -- For computing avg: sum/count
  false_alerts INTEGER DEFAULT 0,
  true_alerts INTEGER DEFAULT 0,
  first_entered_at TEXT,
  last_entered_at TEXT,
  total_days REAL DEFAULT 0
);
```

**Recommendation:** Use the `trust_summary` approach (4 fixed rows). It is simpler, avoids the complexity of tracking level transitions as rows, and the "days at level" can be computed from `last_entered_at` + current time for the active level. The `sum_eval_scores / total_evaluations` pattern avoids needing to store every individual score.

### 3c. Database Location

```
/Users/claude/projects/infra/project-orchestrator/orchestrator.db
```

Add `orchestrator.db` to `.gitignore`. Initialize tables on first access (lazy creation pattern, like conversation-store.js).

### 3d. better-sqlite3 Patterns

Already available as a dependency. Usage pattern from `messenger.js`:
```javascript
const Database = require('better-sqlite3');
const db = new Database(dbPath);
db.prepare('INSERT INTO ...').run(...);
const rows = db.prepare('SELECT ...').all(...);
db.close();
```

**Important:** For the orchestrator DB, keep the connection open (singleton pattern) since it is written frequently. Close only on shutdown. This differs from messenger.js which opens/closes per query (because it reads a system DB it doesn't own).

---

## 4. Trust Metrics and Autonomy Promotion (REV-02, REV-03)

### 4a. Current Autonomy System

**Levels** (from `state.js`):
```
observe -> cautious -> moderate -> full
```

**Autonomy matrix** (from `decision-executor.js`):
- `observe`: No actions (recommend only)
- `cautious`: start sessions, send notifications
- `moderate`: start, stop, restart, notify
- `full`: all actions

**Current level change mechanism:** User sends `ai level <level>` via SMS. The `CommandRouter._handleAILevel()` method calls `state.setAutonomyLevel()`. There is zero automated promotion.

**Phase 06 adds:** The orchestrator can RECOMMEND a promotion but never self-promote. SMS like: "Trust metrics suggest promotion from cautious to moderate. 35 sessions, avg score 3.8/5, 12 days at level. Send `ai level moderate` to approve."

### 4b. Where Trust Data Comes From

**Sessions launched:** Already tracked in `state.executionHistory[]`. Each entry with `action: "start"` is a launched session. Can be counted per autonomy level by checking `executionRecord.autonomyLevel`.

**Evaluation scores:** Already tracked in `state.evaluationHistory[]`. Each evaluation has `score` (1-5) and `projectName`. Can be filtered by time ranges.

**False alert rate:** This is NEW. Requires tracking which notifications the user acted on vs ignored. Possible approaches:
1. **Manual feedback:** User can reply "false alarm" after a notification -- complex, requires new SMS command
2. **Heuristic:** If a notification about project X is followed by no session start or user action within 2 hours, classify as "ignored" (proxy for false alert)
3. **Simplest:** Skip false alert rate for v1. Focus on sessions + eval scores. Add false alerts in Phase 07.

**Recommendation:** Skip false_alert_rate for v1. The threshold check should use sessions_launched + avg_eval_score + days_at_level only. This gives meaningful signal without requiring a complex feedback mechanism.

### 4c. Promotion Threshold Design

**Proposed thresholds (adjustable in config.json):**

```json
"trust": {
  "thresholds": {
    "cautious_to_moderate": {
      "minSessions": 30,
      "minAvgScore": 3.5,
      "minDaysAtLevel": 7
    },
    "moderate_to_full": {
      "minSessions": 50,
      "minAvgScore": 4.0,
      "minDaysAtLevel": 14
    }
  },
  "promotionCheckCron": "0 10 * * *"
}
```

**observe -> cautious:** Not automated. User must explicitly opt in to let the AI start sessions. This is a policy decision, not a trust decision.

**cautious -> moderate:** 30+ sessions launched at cautious level, average eval score >= 3.5, 7+ days at level.

**moderate -> full:** 50+ sessions launched at moderate level, average eval score >= 4.0, 14+ days at level.

**Implementation:** A daily cron job (10 AM) checks trust metrics against thresholds. If crossed, sends a single SMS recommendation. Marks that the recommendation was sent so it is not repeated until the level changes.

### 4d. Feeding Trust into AI Context

Add a new section to `context-assembler.js` `_buildTrustSection()`:

```
Trust Metrics:
- Current level: cautious (since 2026-02-17, 5 days)
- Sessions at this level: 12/30 (40% toward promotion)
- Avg eval score at this level: 3.8/5.0
- Promotion requires: 30 sessions, 3.5+ avg, 7+ days
```

This gives the AI self-awareness of its track record and helps it make better decisions.

---

## 5. Revenue Context Integration (REV-01)

### 5a. ContextAssembler Enhancement

Add `_buildRevenueSection()` to `context-assembler.js`:

```
Revenue:
- XMR Mining: $0.21 balance (0.000629 XMR), hashrate 2592 H/s, est $0.01/day (5min ago)
- MLX API: 0 requests served, 0 tokens generated (5min ago)
- Weekly revenue: $0.07 (XMR: $0.07, MLX: $0.00)
```

**Data age display:** Show "(5min ago)" or "(2h ago)" or "(STALE: 6h ago)" based on `collected_at` vs now.

### 5b. Revenue Collector Module

New file: `lib/revenue-tracker.js`

**Responsibilities:**
1. Periodically fetch XMR pool stats + price (every 5 minutes)
2. Periodically fetch MLX /health metrics (every 5 minutes)
3. Store snapshots in SQLite
4. Provide `getLatestRevenue()` for context assembler
5. Provide `getWeeklyTrend()` for weekly summary SMS

**Architecture:** Stateless query module (like GitTracker) -- called by the main loop's scan interval. Does not own a timer; the main loop calls `revenueTracker.collect()` on the existing 60-second scan interval (or at a configurable sub-interval).

**Error handling:** Individual source failures are independent. If XMR API fails but MLX succeeds, store NULL for XMR and real data for MLX. Never let one source failure block another.

---

## 6. Scheduled Digests (REV-04, REV-05)

### 6a. Weekly Revenue Summary (REV-04)

**Schedule:** Sunday mornings. Piggyback on the existing morning digest cron (`0 7 * * *`) but only on Sundays, OR add a separate cron entry.

**Preferred approach:** Add a new cron job `0 7 * * 0` (7 AM Sundays) that generates and sends the weekly summary. Uses the same `scheduler.js` pattern as `startMorningDigest()`.

**Content structure:**
```
Weekly Revenue Summary (Feb 10-16):

XMR Mining:
  Balance: 0.000629 XMR ($0.21)
  Weekly earned: +0.000045 XMR (+$0.01)
  Hashrate avg: 2,592 H/s
  Week-over-week: +5% (vs $0.01 last week)

MLX API:
  Requests this week: 0
  Tokens generated: 0
  Revenue: $0.00 (no active subscribers)

Total weekly: $0.01
```

**Data source:** Query `revenue_snapshots` for the last 7 days and the 7 days before that. Compare totals for WoW trends.

### 6b. Evening Wind-Down Digest (REV-05)

**Schedule:** 9:45 PM ET daily (before quiet hours at 10 PM).
**Cron:** `45 21 * * *` (America/New_York timezone)

**Content:** AI-generated via `claude -p` (like the morning digest). Prompt includes:
1. Today's session accomplishments (from `state.executionHistory` + `state.evaluationHistory`, filtered to today)
2. Commits across all projects today (GitTracker across all project dirs)
3. Tomorrow's plan (AI infers from current project states + priorities)

**Implementation pattern:** Same as `aiBrain.generateDigest()` but with an evening-specific prompt template. Reuses `claudePWithSemaphore` for the AI call.

**SMS budget impact:** +1 SMS/day for evening digest, +1 SMS/week for weekly summary. Well within the 20/day budget.

### 6c. Scheduling Architecture

Currently, `scheduler.js` has `startMorningDigest()` which accepts a callback. Need to generalize to support multiple scheduled jobs.

**Options:**
1. Add `startEveningDigest(callback)` and `startWeeklySummary(callback)` methods -- simple, follows existing pattern
2. Generalize to `scheduleJob(name, cron, callback)` -- more flexible

**Recommendation:** Option 1. Keep it simple. Three explicit methods. The scheduler is not a generic job runner; it's a small module with known jobs. Adding a generic API for 3 jobs is over-engineering.

---

## 7. Integration Points and Dependencies

### 7a. Dependencies on Phase 04 (Session Intelligence)

- **SessionEvaluator scores:** Already writes to `state.evaluationHistory[]`. Trust metrics (REV-02) read these scores to compute averages.
- **GitTracker:** Already in `lib/git-tracker.js`. Evening digest (REV-05) calls `gitTracker.getProgress()` across all project directories for today's commits.

**Verified working:** Both modules are complete and tested.

### 7b. Dependencies on Phase 03 (Foundation Hardening)

- **Structured output:** Revenue context will be in AI prompts consumed by `claude -p --json-schema`.
- **Semaphore:** Evening digest uses `claudePWithSemaphore` (same as morning digest).
- **Conversation store:** No direct dependency.

### 7c. New Module Dependencies

| New Module | Depends On | Depended On By |
|-----------|-----------|----------------|
| `revenue-tracker.js` | better-sqlite3, native fetch | context-assembler.js, index.js |
| `trust-tracker.js` | state.js (evaluationHistory, executionHistory) | context-assembler.js, index.js |

### 7d. Index.js Wiring

Main orchestrator loop changes:
1. Initialize `revenueTracker` and `trustTracker` at startup
2. Call `revenueTracker.collect()` in the scan interval (or a sub-interval)
3. Pass both to `contextAssembler` constructor
4. Add evening digest and weekly summary cron jobs in startup
5. Add trust promotion check in scan interval or daily cron

---

## 8. Risk Analysis

### 8a. External API Reliability

**SupportXMR API:**
- No auth required (public)
- Historically stable but no SLA
- Rate limits unknown (assume conservative: 1 req/5min is safe)
- Risk: Pool could change API, go down, or deprecate
- Mitigation: Store NULL on failure, alert if 3+ consecutive failures

**CoinGecko API:**
- Free tier: 10-30 req/min, no auth
- Risk: Rate limiting if called too frequently
- Mitigation: Cache price for 5 minutes, only fetch with XMR snapshot

**MLX /health endpoint:**
- Local (localhost:8100), same machine
- Already health-monitored by Phase 05
- Risk: Service restarts reset counters (requests_served goes to 0)
- Mitigation: Detect counter resets (new value < previous stored value) and handle gracefully

### 8b. SQLite Risks

- **First orchestrator-owned DB:** New pattern. Ensure WAL mode for concurrent reads.
- **Schema migration:** No migration framework. Use `CREATE TABLE IF NOT EXISTS` for forward compatibility.
- **Disk usage:** At 5-min intervals, ~288 rows/day, ~2000/week. With pruning (keep 90 days), max ~26K rows. Negligible.
- **Graceful shutdown:** Close DB connection on SIGINT/SIGTERM.

### 8c. Trust Threshold Risks

- **Cold start:** No evaluations exist yet. Trust metrics will show 0/30 sessions until the system runs for a while. This is expected and correct behavior.
- **Never self-promote:** Critical safety property. Code review must verify no code path calls `state.setAutonomyLevel()` from trust tracker.
- **Threshold gaming:** Not a concern in single-user system where user controls all inputs.

---

## 9. Plan Decomposition (Suggested)

Based on dependency analysis and the phase velocity (~3min/plan), suggest 4 plans:

### Plan 06-01: Revenue Tracker + SQLite Foundation
**Tasks:**
- Create `lib/revenue-tracker.js` with SQLite schema, `collect()`, and `getLatest()` methods
- Implement XMR mining data collection (SupportXMR API + CoinGecko price)
- Implement MLX API usage collection (/health endpoint)
- NULL vs zero handling, data age tracking
- Add `orchestrator.db` to `.gitignore`
**Covers:** REV-01 (core)

### Plan 06-02: Trust Tracker + Promotion Recommendations
**Tasks:**
- Create `lib/trust-tracker.js` with trust_summary SQLite table
- Accumulate trust metrics from evaluationHistory and executionHistory
- Implement promotion threshold checking with configurable thresholds
- Send promotion recommendation SMS (never self-promote)
- Add trust thresholds to config.json
**Covers:** REV-02, REV-03

### Plan 06-03: Context Assembly + Revenue/Trust in AI Prompts
**Tasks:**
- Add `_buildRevenueSection()` to context-assembler.js
- Add `_buildTrustSection()` to context-assembler.js
- Wire revenueTracker and trustTracker into index.js (constructor, scan loop)
- Add to mock dependencies in test/helpers.js
**Covers:** REV-01 (context), REV-02 (context)

### Plan 06-04: Scheduled Digests + Tests
**Tasks:**
- Add evening digest cron (9:45 PM) with AI-generated content via claudePWithSemaphore
- Add weekly revenue summary cron (Sunday 7 AM) with per-source breakdown and WoW trends
- Add scheduler methods: `startEveningDigest()`, `startWeeklySummary()`
- Integration tests for revenue-tracker and trust-tracker
**Covers:** REV-04, REV-05

### Alternative: 5-plan decomposition
If the evening digest and weekly summary are complex enough to warrant separation:
- 06-04: Evening wind-down digest (REV-05)
- 06-05: Weekly revenue summary + tests (REV-04 + tests)

**Recommendation:** Start with 4 plans. If 06-04 exceeds ~5 minutes execution time, split during planning.

---

## 10. Key Design Decisions to Make During Planning

1. **Single DB or separate DB per feature?** Recommendation: Single `orchestrator.db` with multiple tables. Simpler ops, single backup, single connection.

2. **Revenue collection interval:** 5 minutes (12 collections/hour). Not on every 60-second scan -- too aggressive for external APIs. Use a modulo check in the scan loop: `if (scanCount % 5 === 0) revenueTracker.collect()`.

3. **Trust metrics persistence:** SQLite table or extend `.state.json`? Recommendation: SQLite (same DB as revenue). Keeps .state.json for volatile runtime state, SQLite for historical data.

4. **Evening digest: template or AI?** AI-generated (like morning digest). The AI can reason about what to highlight from the day's data. Falls back to a template if claude -p fails.

5. **Revenue data retention:** Keep 90 days of snapshots, prune older rows weekly. At 288 rows/day, that is ~26K rows -- trivial for SQLite.

6. **Weekly summary: separate SMS or part of Sunday morning digest?** Separate SMS. The morning digest covers project status; the weekly summary covers revenue specifically. Different audiences (progress vs money).

7. **Trust promotion check frequency:** Once daily at 10 AM (not every scan cycle). Promotion is a slow process measured in days/weeks; checking every 60 seconds is wasteful.

---

## 11. Existing Code Patterns to Follow

### Module Construction Pattern
```javascript
class RevenueTracker {
  constructor({ config, state }) {
    this.config = config;
    this.state = state;
    this.db = null; // Lazy init
  }
}
```

### Lazy SQLite Initialization
```javascript
_ensureDb() {
  if (this.db) return;
  this.db = new Database(path.join(__dirname, '..', 'orchestrator.db'));
  this.db.pragma('journal_mode = WAL');
  this.db.exec(`CREATE TABLE IF NOT EXISTS ...`);
}
```

### Context Section Pattern (from context-assembler.js)
```javascript
_buildRevenueSection() {
  if (!this.revenueTracker) return null;
  try {
    return this.revenueTracker.formatForContext();
  } catch {
    return 'Revenue: data unavailable';
  }
}
```

### Cron Scheduling Pattern (from scheduler.js)
```javascript
startEveningDigest(callback) {
  const job = cron.schedule('45 21 * * *', () => {
    callback();
  }, { timezone: this.config.quietHours.timezone });
  this._jobs.push(job);
}
```

### Test Pattern (from test/helpers.js)
```javascript
revenueTracker: {
  collect: async () => {},
  getLatest: () => ({ xmr: null, mlx: null }),
  formatForContext: () => 'Revenue: all mocked',
  getWeeklyTrend: () => ({ thisWeek: 0, lastWeek: 0, change: 0 }),
},
trustTracker: {
  update: () => {},
  checkPromotion: () => null,
  formatForContext: () => 'Trust: all mocked',
  getMetrics: () => ({ level: 'observe', sessions: 0, avgScore: 0, days: 0 }),
},
```

---

## 12. Verification Criteria (How to Know Phase 06 is Done)

These map directly to the success criteria from the ROADMAP:

1. **Revenue collection works:** After running for 5 minutes, `orchestrator.db` has revenue_snapshots rows for both XMR and MLX, with proper NULL vs zero distinction. AI context shows per-source earnings with data age.

2. **Trust metrics accumulate:** After evaluating a mock session, trust_summary table shows updated session count and average score for the current autonomy level.

3. **Promotion recommendation:** Setting trust metrics above threshold triggers a single SMS recommendation. Verify no code path calls `state.setAutonomyLevel()` from trust tracker.

4. **Weekly summary:** On Sunday morning (or when manually triggered), the orchestrator sends a revenue SMS with per-source breakdown. WoW trends show "N/A" for the first week, then real percentages.

5. **Evening digest:** At 9:45 PM (or when manually triggered), the orchestrator sends an AI-generated wind-down summary with today's commits and accomplishments.
