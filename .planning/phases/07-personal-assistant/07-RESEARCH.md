# Phase 07 Research: Personal Assistant

**Phase:** 07 - Personal Assistant
**Researched:** 2026-02-17
**Objective:** What do I need to know to PLAN this phase well?

---

## 1. Requirements Recap

| Req | Summary | Key Constraint |
|-----|---------|----------------|
| PA-01 | Reminder system: user texts "remind me to X at Y", persists to disk, fires at scheduled time via notification system | Zero new npm deps (node-cron already available for scheduling) |
| PA-02 | SQLite-backed conversation history: migrate from JSON file to SQLite, expand to 100 exchanges, enable fact/preference extraction | orchestrator.db already exists (Phase 06), better-sqlite3 already installed |
| PA-03 | MCP server access for managed sessions: configure `claude --dangerously-skip-permissions` sessions with GitHub, filesystem MCP via `--mcp-config` or `.mcp.json` | MCP servers already configured at user scope; `--mcp-config` flag available on claude CLI |
| PA-04 | Learning from evaluations: after 50+ evals, identify patterns in prompt styles/durations that yield best scores, feed back into session decisions | Currently 0 evaluations in state; pattern analysis is forward-looking |

---

## 2. PA-01: Reminder System

### 2a. Natural Language Time Parsing

The user will text things like:
- "remind me to check YouTube OAuth tomorrow at 10am"
- "remind me to renew certs in 2 hours"
- "reminder: check Gumroad sales next Monday"

**Parsing approach (zero new dependencies):** Use `claude -p` to parse the natural language into structured JSON. This is consistent with the v3.0 decision to route all NL through `claude -p`.

**Proposed JSON schema for reminder extraction:**
```json
{
  "type": "object",
  "properties": {
    "text": { "type": "string" },
    "fireAt": { "type": "string" },
    "isRelative": { "type": "boolean" },
    "relativeMs": { "type": "integer" },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "required": ["text", "fireAt", "confidence"]
}
```

Where `fireAt` is an ISO 8601 timestamp. The AI can calculate the absolute time from relative expressions ("tomorrow at 10am", "in 2 hours") since the current time is always included in the context prompt.

**Alternative: simple regex parsing.** For common patterns like "in X hours/minutes", "tomorrow at HH:MM", "next Monday at HH:MM", a regex-based parser could work without an LLM call. But this creates a fragile parser for diminishing returns -- the `claude -p` approach is more robust and consistent with existing architecture.

**Recommendation:** Use `claude -p` with `--json-schema` for time parsing. This consumes a semaphore slot but reminders are infrequent (maybe 1-2/day). The zero-dependency constraint rules out libraries like `chrono-node` (natural language date parser).

### 2b. Persistent Storage

**Current state:** No reminder storage exists anywhere in the codebase.

**Storage options:**
1. **SQLite (orchestrator.db)** -- Consistent with Phase 06 pattern. A `reminders` table alongside `revenue_snapshots` and `trust_summary`.
2. **JSON file** -- Simpler, but inconsistent with the direction established in Phase 06.

**Recommendation:** SQLite. The lazy-init pattern from RevenueTracker/TrustTracker is proven and avoids opening DB connections at startup if no reminders exist.

**Proposed schema:**
```sql
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  fire_at TEXT NOT NULL,           -- ISO 8601 timestamp
  created_at TEXT NOT NULL,        -- ISO 8601 timestamp
  fired INTEGER DEFAULT 0,         -- 0 = pending, 1 = fired
  sms_text TEXT                    -- Optional: pre-formatted SMS text
);
CREATE INDEX IF NOT EXISTS idx_reminders_pending
  ON reminders(fired, fire_at);
```

### 2c. Scheduling and Firing

**Current scheduling infrastructure:**
- `node-cron` is already a dependency (used by Scheduler for morning/evening digests)
- The orchestrator's scan interval runs every 60s (`scanIntervalMs: 60000`)

**Two approaches for firing reminders:**

1. **Poll-based (recommended):** Check pending reminders every scan cycle (60s). Query: `SELECT * FROM reminders WHERE fired = 0 AND fire_at <= datetime('now')`. Simple, reliable, fits the existing polling architecture. Worst-case latency: 60s (acceptable for SMS reminders).

2. **Cron-based:** Create a node-cron job for each reminder. More precise timing but creates complexity: managing dynamic cron jobs, cleanup, persistence across restarts.

**Recommendation:** Poll-based. Add a `checkReminders()` call to the existing scan interval in index.js. When a reminder fires:
1. Send SMS via `notificationManager.notify(text, NotificationManager.ACTION)` (tier 2)
2. Mark `fired = 1` in SQLite
3. Log to console

### 2d. Integration with SMS Flow

The reminder-setting flow happens inside `_handleNaturalLanguage()` in commands.js. When the AI detects the user wants to set a reminder, it needs to:

1. Parse the reminder into structured data (text + fireAt)
2. Store it in SQLite
3. Confirm to the user ("Got it. I'll remind you to check YouTube OAuth tomorrow at 10:00 AM.")

**Key question:** How does the AI "set" a reminder from within a `claude -p` call?

**Option A: Two-step flow.** The NL handler detects "remind" intent, extracts the reminder via a dedicated `claude -p` call with `--json-schema`, then stores it. The NL handler already routes all text through AI -- the AI's response can include a structured indicator that it detected a reminder intent.

**Option B: Tool-based.** Give the NL handler `claude -p` call access to an MCP tool that sets reminders. This is the Phase 05 MCP bridge pattern. However, this is overkill for a simple insert.

**Recommendation: Option A (two-step).** Modify `_handleNaturalLanguage()` to detect reminder intent in the AI response (e.g., a special prefix like `[REMINDER:...]` or a separate JSON schema call). Simpler and cheaper than MCP round-trips.

**Better approach:** Have the NL handler's system prompt include instructions: "If the user wants to set a reminder, include `REMINDER_JSON:{"text":"...","fireAt":"..."}` at the end of your response." Then the handler parses this out, stores the reminder, and strips it from the SMS response.

### 2e. Edge Cases

- **Timezone:** The orchestrator runs in `America/New_York` (configured). All times should be interpreted in this timezone unless explicitly stated. The AI can handle this if told the timezone in the prompt.
- **Past times:** Reject or immediately fire? Immediately fire (send SMS now, mark as fired).
- **Duplicate reminders:** No dedup needed -- user explicitly requested each one.
- **Cancellation:** Allow "cancel reminder about X" -- query by text LIKE match, mark as fired.
- **Listing:** Allow "what reminders do I have?" -- query pending reminders, format as SMS.

### 2f. Existing Patterns to Follow

- Lazy SQLite init pattern from RevenueTracker (`_ensureDb()`)
- Poll pattern from scan interval in index.js
- Notification tier 2 (ACTION) for fired reminders
- `claudePWithSemaphore` with `--json-schema` for structured extraction

---

## 3. PA-02: SQLite-Backed Conversation History

### 3a. Current Implementation

**File:** `/Users/claude/projects/infra/project-orchestrator/lib/conversation-store.js`
**Storage:** `.conversation-history.json` (JSON file)
**Limits:** 20 messages max, 24h TTL, credential filtering
**Usage:** Pushed on user message and AI response in `_handleNaturalLanguage()` (commands.js). Retrieved with `getRecent(4)` for multi-turn SMS context.

**Current entry format:**
```json
{ "role": "user|assistant", "text": "...", "ts": 1708000000000 }
```

### 3b. Migration to SQLite

**Target:** 100 exchanges (up from 20), stored in orchestrator.db alongside revenue/trust tables.

**Proposed schema:**
```sql
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,              -- 'user' or 'assistant'
  text TEXT NOT NULL,
  ts INTEGER NOT NULL,            -- Unix timestamp in milliseconds
  created_at TEXT NOT NULL        -- ISO 8601 for human readability
);
CREATE INDEX IF NOT EXISTS idx_conversations_ts
  ON conversations(ts);
```

**Migration approach:**
1. New `ConversationStoreSQLite` class (or update existing `ConversationStore`)
2. Same public API: `push(entry)`, `getRecent(count)`, `getAll()`, `clear()`
3. Add `search(query)` for fact recall
4. Add `extractFacts()` for user-declared preferences/facts
5. Drop the JSON file after migration

**Recommendation:** Replace the existing `ConversationStore` class in-place. It's only used in two places (index.js instantiation + commands.js injection). The API stays the same but the backend changes from JSON to SQLite.

### 3c. Fact Extraction and Recall

**Requirement:** "AI references past conversations and user-declared facts."

The user might say things like:
- "My RapidAPI key expires on March 15"
- "The DemocratDollar app needs signing certs"
- "I prefer starting sessions before 9am"

**Two approaches:**

1. **Passive recall (recommended for v1):** The NL handler already passes `getRecent(4)` history to the AI prompt. Expanding to `getRecent(10)` or even a keyword search of recent history would let the AI reference past conversations naturally. No explicit "fact extraction" needed -- the AI can read conversation history in the prompt.

2. **Active extraction:** Periodically run a `claude -p` call to extract "facts" from conversation history into a `user_facts` table. The AI can then be told: "User facts: [list]". This is more structured but costs LLM calls.

**Recommendation:** Start with passive recall (expand `getRecent()` to 10, add full-text search capability). The 100-exchange SQLite history gives plenty of context for the AI to reference. Active fact extraction can be a future enhancement.

**SQLite full-text search:** SQLite has FTS5 built in, but `better-sqlite3` supports it. However, for 100 rows, a simple `LIKE '%query%'` is fast enough. FTS5 is overkill.

### 3d. TTL and Pruning

**Current:** 24h TTL, pruned on every read.
**Proposed:** No TTL for SQLite (keep all 100 exchanges). Prune by count only: when inserting, if row count > 100, delete oldest rows. This is more useful for a personal assistant -- the user said something 3 days ago and the AI should still remember it.

**Alternative:** Keep a configurable TTL (e.g., 7 days) but increase the cap to 100. This prevents the DB from growing unbounded while retaining useful context.

**Recommendation:** 7-day TTL + 100 message cap. Prune on insert (same pattern as current implementation).

### 3e. Credential Filtering

The existing `_filterCredentials()` method must be preserved. It redacts:
- OpenAI keys (`sk-...`)
- Stripe live keys (`sk_live_...`)
- GitHub PATs (`ghp_...`)
- Slack tokens (`xoxb-...`)
- Generic key/token/bearer patterns

This is critical for security and should carry over to the SQLite implementation unchanged.

### 3f. Backward Compatibility

The ConversationStore is instantiated in `index.js` (line 100) and injected into `CommandRouter` (line 114). The switch from JSON to SQLite should be transparent to all callers. The constructor signature may change slightly (add db path option), but the public methods remain identical.

On first run after migration, optionally load existing `.conversation-history.json` into SQLite, then delete the JSON file.

---

## 4. PA-03: MCP Server Access for Managed Sessions

### 4a. Current Session Launch Mechanism

**File:** `/Users/claude/projects/infra/project-orchestrator/lib/session-manager.js`
**Method:** `startSession()` launches tmux with `claude --dangerously-skip-permissions`

Current launch command (line 94-98):
```javascript
execSync(
  `tmux new-session -d -s "${sessionName}" -c "${projectDir}" ` +
    `"claude --dangerously-skip-permissions"`,
  { timeout: 10000 }
);
```

The session runs `claude` interactively (not `claude -p`). It uses `--dangerously-skip-permissions` for autonomous operation (the v3.0 decision documented in STATE.md: "session-manager.js --dangerously-skip-permissions left intact (interactive sessions, not claude -p)").

### 4b. MCP Server Configuration Approaches

The `claude` CLI supports MCP configuration in three ways:

1. **User-scope MCP servers** (already configured): These are available to ALL Claude sessions automatically. Currently configured: github, filesystem, docker-mcp, google-calendar, apple-mcp, memory, firecrawl, playwright, context7, glif, apple-shortcuts. These are ALREADY available to managed sessions because they're in user config.

2. **`--mcp-config <file>`**: Pass a JSON file with additional MCP server configs. Format: `{"mcpServers": {"name": {"command": "...", "args": [...], "env": {...}}}}`. This is useful for session-specific MCP access.

3. **`.mcp.json` in project directory**: Project-level MCP config. Claude auto-discovers this file. However, managed sessions already trust `.mcp.json` since they use `--dangerously-skip-permissions`.

4. **`--allowedTools <tools>`**: Restricts which tools the session can use. This is a RESTRICTION mechanism, not an enablement one. With `--dangerously-skip-permissions`, all tools are already allowed.

### 4c. Key Insight: MCP Servers Are Already Available

Since MCP servers are configured at user scope (verified by `claude mcp list`), and managed sessions run under the same user, **all configured MCP servers are already available to managed sessions**. The sessions already have access to:
- `github` (with PAT for `mcp__github__*` tools)
- `filesystem` (configured at local scope for /Users/claude/projects)
- `docker-mcp`
- `google-calendar`
- `apple-mcp` (Reminders, Notes, Calendar)
- `memory` (Knowledge graph)

### 4d. What PA-03 Actually Needs to Do

Given the above, PA-03 is about:

1. **Verification:** Confirm that managed sessions CAN use MCP tools. Test by starting a session and having it use a GitHub tool.

2. **Selective enablement:** Use `--allowedTools` to RESTRICT sessions to only the MCP tools they need (principle of least privilege). For example, a session working on `web-scraping-biz` might only need `mcp__github__*` and `mcp__filesystem__*`, not `mcp__docker-mcp__*`.

3. **MCP-aware session prompts:** When the orchestrator starts a session, the prompt should mention available MCP capabilities: "You have access to GitHub (create PRs, read issues) and filesystem tools."

4. **Session `.mcp.json` generation:** For project-specific MCP needs, the orchestrator could write a `.mcp.json` file into the project directory before launching the session. This is useful for project-specific MCP servers not in user config.

### 4e. Implementation Approach

**Option A: `--allowedTools` in session launch (recommended):**
Modify `startSession()` to accept an optional `allowedTools` array. Add it to the tmux command:
```javascript
const toolsFlag = allowedTools
  ? allowedTools.map(t => `--allowedTools "${t}"`).join(' ')
  : '';
execSync(
  `tmux new-session -d -s "${sessionName}" -c "${projectDir}" ` +
    `"claude --dangerously-skip-permissions ${toolsFlag}"`,
  { timeout: 10000 }
);
```

However, note that `--dangerously-skip-permissions` already bypasses all permission checks. The `--allowedTools` flag might not have effect when combined with it. This needs verification.

**Option B: `--mcp-config` for session-specific servers:**
Generate a temporary MCP config JSON and pass it via `--mcp-config`:
```javascript
const mcpConfig = {
  mcpServers: {
    github: { command: '/opt/homebrew/bin/github-mcp-server', args: ['stdio'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '...' } }
  }
};
const configFile = path.join(signalDir, 'mcp-config.json');
fs.writeFileSync(configFile, JSON.stringify(mcpConfig));
// Add `--mcp-config ${configFile}` to launch command
```

**Recommendation:** Start with Option A (verify that user-scope MCP servers are already available). If they are, PA-03 is largely about:
1. Adding MCP capability info to session prompts
2. Optionally writing project-specific `.mcp.json` files
3. Testing that sessions can actually invoke MCP tools

### 4f. MCP Bridge vs Session MCP

Important distinction:
- **MCP Bridge (Phase 05):** The orchestrator's own `claude -p` calls using `--allowedTools` for AI brain queries. This is `MCPBridge.queryMCP()`.
- **Session MCP (PA-03):** Managed interactive Claude sessions having access to MCP tools during their autonomous work.

These are separate systems. The MCP bridge circuit breaker status doesn't affect session MCP availability (sessions use their own Claude process, not `claude -p`).

### 4g. Verified MCP Server Details

From `claude mcp list` and `claude mcp get`:

| Server | Scope | Command | Status |
|--------|-------|---------|--------|
| github | User | `/opt/homebrew/bin/github-mcp-server stdio` | Connected, has PAT |
| filesystem | Local | `npx -y @modelcontextprotocol/server-filesystem /Users/claude/projects /Users/claude` | Connected |
| docker-mcp | User | `uvx docker-mcp` | Connected |
| google-calendar | User | `npx --yes @cocal/google-calendar-mcp` | Connected |
| apple-mcp | User | `npx --yes apple-mcp@latest` | Connected |
| memory | User | `npx -y @modelcontextprotocol/server-memory` | Connected |
| firecrawl | User | `npx -y firecrawl-mcp` | Connected |
| playwright | User | `npx -y @playwright/mcp` | Connected |
| context7 | User | `npx -y @upstash/context7-mcp` | Connected |

Note: `filesystem` is at LOCAL scope (this project only). Sessions in other project directories won't see it unless it's also configured at user scope. This might need to be addressed.

---

## 5. PA-04: Learning from Evaluations

### 5a. Current Evaluation Data

**State of data (verified 2026-02-17):**
- `evaluationHistory`: 0 evaluations (the orchestrator has not yet run in active mode with sessions completing)
- `executionHistory`: 0 executions
- `aiDecisionHistory`: 50 entries (think cycle decisions)

**Evaluation schema (from SessionEvaluator):**
```javascript
{
  sessionId,      // tmux session name
  projectName,    // e.g., "revenue/web-scraping-biz"
  startedAt,      // ISO timestamp
  stoppedAt,      // ISO timestamp
  durationMinutes,
  gitProgress: {
    commitCount,
    insertions,
    deletions,
    filesChanged,
    lastCommitMessage,
    noGit: false
  },
  score,          // 1-5
  recommendation, // continue|retry|escalate|complete
  accomplishments,// string[]
  failures,       // string[]
  reasoning,      // string
  evaluatedAt     // ISO timestamp
}
```

### 5b. What Patterns to Track

Once 50+ evaluations accumulate, we can identify:

1. **Prompt style correlations:** Do sessions with specific prompt templates (e.g., "Resume work on..." vs "Focus on fixing...") yield higher scores?
2. **Duration sweet spots:** Do 20-minute sessions outperform 45-minute sessions? Do certain projects have optimal session durations?
3. **Project-level patterns:** Which projects consistently score high/low? Which need shorter sessions?
4. **Time-of-day patterns:** Do morning sessions score better than afternoon sessions?
5. **Retry effectiveness:** When a session scores low and is retried, does the retry score higher?

### 5c. Storage Design

**Option A: SQLite table (recommended):**
Store evaluation history in orchestrator.db instead of/alongside .state.json. This allows SQL queries for pattern analysis.

```sql
CREATE TABLE IF NOT EXISTS session_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  duration_minutes INTEGER,
  commit_count INTEGER,
  insertions INTEGER,
  deletions INTEGER,
  files_changed INTEGER,
  score INTEGER,
  recommendation TEXT,
  prompt_snippet TEXT,             -- First 200 chars of prompt
  prompt_style TEXT,               -- Classified: 'resume', 'fix', 'implement', 'explore'
  evaluated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evals_project
  ON session_evaluations(project_name);
CREATE INDEX IF NOT EXISTS idx_evals_score
  ON session_evaluations(score);
```

**Option B: Stay in .state.json.** Already stores `evaluationHistory` (capped at 100). Could add pattern analysis on top of existing data.

**Recommendation:** Migrate evaluation history to SQLite for better querying. The .state.json `evaluationHistory` array is capped at 100 entries, which is perfect for the 50+ threshold. However, SQLite allows richer queries (GROUP BY project, AVG score, etc.) without loading all 100 entries into memory.

### 5d. Pattern Analysis Implementation

**When to analyze:** Not on every think cycle (too expensive). Options:
1. **Periodic:** Once daily (e.g., during morning digest generation)
2. **Threshold:** After every 10th new evaluation
3. **On-demand:** When the AI context is assembled, include a cached pattern summary

**Recommendation:** Threshold-based. After every 10th evaluation, run pattern analysis and cache the results. Include cached patterns in the AI context.

**Analysis queries (pure SQL, no LLM needed):**

```sql
-- Average score by project
SELECT project_name, AVG(score) as avg_score, COUNT(*) as sessions
FROM session_evaluations GROUP BY project_name HAVING sessions >= 3;

-- Average score by prompt style
SELECT prompt_style, AVG(score) as avg_score, COUNT(*) as sessions
FROM session_evaluations GROUP BY prompt_style HAVING sessions >= 5;

-- Optimal duration range (score >= 4 sessions)
SELECT project_name, AVG(duration_minutes) as optimal_duration
FROM session_evaluations WHERE score >= 4 GROUP BY project_name;

-- Time-of-day analysis
SELECT
  CAST(strftime('%H', started_at) AS INTEGER) / 4 as time_block,
  AVG(score) as avg_score
FROM session_evaluations GROUP BY time_block;
```

**Feeding patterns back:** Add a `_buildLearningsSection()` to ContextAssembler that includes pattern insights in the AI context. For example:
```
Session Learnings (from 57 evaluations):
- web-scraping-biz: avg 4.2/5 (best with "fix" prompts, optimal duration ~20min)
- land-speculation: avg 2.8/5 (struggles with "explore" prompts)
- Overall: morning sessions score 0.5 points higher than afternoon
```

### 5e. Prompt Style Classification

To correlate prompt styles with scores, classify each session's prompt:
- "Resume work on..." -> `resume`
- "Fix..." or "Bug..." -> `fix`
- "Implement..." or "Add..." -> `implement`
- "Explore..." or "Read..." -> `explore`
- Custom user prompt -> `custom`

This classification can be done with simple keyword matching (no LLM needed):
```javascript
function classifyPromptStyle(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.includes('fix') || lower.includes('bug')) return 'fix';
  if (lower.includes('implement') || lower.includes('add') || lower.includes('create')) return 'implement';
  if (lower.includes('explore') || lower.includes('read') || lower.includes('understand')) return 'explore';
  if (lower.includes('resume') || lower.includes('continue')) return 'resume';
  return 'custom';
}
```

### 5f. Cold Start Problem

With 0 evaluations today, the learning system won't produce useful insights until the orchestrator has been running in cautious/moderate mode for a while and sessions complete. The requirement says "requires 50+ evaluations."

**Approach:**
1. Start storing evaluations in SQLite immediately (even if no patterns are generated yet)
2. Show "Insufficient data (X/50 evaluations)" in context until threshold is met
3. Once threshold is met, generate patterns and include in AI context

---

## 6. Existing Infrastructure to Leverage

### 6a. SQLite (orchestrator.db)

Already created in Phase 06. Contains:
- `revenue_snapshots` (RevenueTracker)
- `trust_summary` (TrustTracker)

Phase 07 adds:
- `reminders` (PA-01)
- `conversations` (PA-02)
- `session_evaluations` (PA-04)

All use the same lazy-init pattern with `_ensureDb()`.

### 6b. node-cron

Already a dependency. Used by Scheduler for morning/evening/weekly digests. Available for reminder scheduling if needed, but poll-based approach is recommended.

### 6c. NotificationManager

Tier-based notification system with daily budget. Reminders should use tier 2 (ACTION) -- important enough to send immediately, but not urgent enough to bypass quiet hours.

**Edge case:** What if a reminder fires during quiet hours? The user explicitly asked for it at that time. Options:
1. Fire anyway (override quiet hours for user-requested reminders)
2. Queue until quiet hours end (user gets reminder late)

**Recommendation:** Fire anyway. The user explicitly set the time. Add a `bypassQuiet` option to `notify()` or use tier 1 (URGENT) for reminders.

### 6d. ConversationStore

Current implementation is 150 lines. The SQLite migration replaces the JSON backend but keeps the same API.

### 6e. SessionEvaluator + State

`logEvaluation()` in StateManager writes to `evaluationHistory` in .state.json. PA-04 should additionally write to the SQLite `session_evaluations` table for richer querying.

### 6f. ContextAssembler

Already has sections for resources, health, revenue, trust, evaluations. PA-07 adds:
- Pending reminders count
- Conversation memory summary (e.g., "Last 10 exchanges in memory")
- Session learning patterns (when 50+ evals exist)
- MCP server availability for sessions

---

## 7. Risk Analysis

### 7a. Semaphore Pressure

PA-01 adds a `claude -p` call for reminder time parsing (infrequent, 1-2/day). PA-02 does not add LLM calls (SQLite only). PA-04 does not add LLM calls (SQL queries only). Overall semaphore pressure increase: minimal.

### 7b. SQLite Contention

Three new tables in orchestrator.db, but:
- WAL mode is already enabled (concurrent reads)
- All writes are infrequent (reminder creation, conversation push, evaluation logging)
- No risk of write contention between components

### 7c. Data Volume

- Reminders: ~1-5 per day, marked as fired, prunable after 30 days
- Conversations: 100 max, 7-day TTL, auto-pruned
- Evaluations: 1-5 per day, kept indefinitely for learning (but only analyzed in aggregate)

### 7d. Backward Compatibility

- ConversationStore API unchanged (callers unaffected)
- SessionManager gets optional `allowedTools` parameter (backward compatible)
- ContextAssembler gets new sections (additive, no breakage)
- State evaluationHistory continues to work (SQLite is supplementary)

### 7e. Testing

All new components should have test coverage:
- ReminderManager: creation, firing, listing, cancellation, time parsing
- ConversationStore (SQLite): push, getRecent, search, pruning, credential filtering
- SessionLearner: pattern analysis queries, cold start handling
- Session MCP: launch with MCP config verification

---

## 8. Proposed Plan Breakdown

Based on the research above, Phase 07 decomposes into 4 plans:

### Plan 07-01: Reminder System (PA-01)
**New file:** `lib/reminder-manager.js`
**Touches:** `index.js` (scan loop integration), `commands.js` (NL detection)
**Tasks:**
1. ReminderManager class with SQLite storage (lazy init, `reminders` table)
2. `setReminder(text, fireAtISO)` -- stores in DB
3. `checkAndFire()` -- polled from scan loop, fires pending reminders via NotificationManager
4. `listPending()` -- returns pending reminders for SMS
5. `cancelByText(query)` -- fuzzy-match cancellation
6. NL integration: system prompt update to detect reminder intent, extract JSON, call setReminder
7. index.js: add `checkReminders()` to scan interval
8. Test file

### Plan 07-02: SQLite Conversation History (PA-02)
**Modifies:** `lib/conversation-store.js`
**Touches:** `index.js` (constructor change), `commands.js` (expanded getRecent)
**Tasks:**
1. Replace JSON backend with SQLite (`conversations` table in orchestrator.db)
2. Migrate existing `.conversation-history.json` on first run
3. Expand cap from 20 to 100, TTL from 24h to 7 days
4. Add `search(query)` method for keyword recall
5. Add conversation summary to AI context (ContextAssembler)
6. Preserve credential filtering
7. Test file (update existing conversation-store.test.js)

### Plan 07-03: MCP for Managed Sessions (PA-03)
**Modifies:** `lib/session-manager.js`
**Touches:** `lib/context-assembler.js` (MCP awareness in prompts)
**Tasks:**
1. Verify user-scope MCP servers are available in managed sessions (manual/test verification)
2. Add optional `mcpConfig` parameter to `startSession()` for project-specific MCP
3. Generate `.mcp.json` for projects that need custom MCP access
4. Update session resume prompts to mention available MCP capabilities
5. Test file

### Plan 07-04: Session Learning (PA-04)
**New file:** `lib/session-learner.js`
**Modifies:** `lib/context-assembler.js`, `lib/session-evaluator.js`
**Touches:** `index.js` (integration)
**Tasks:**
1. SessionLearner class with SQLite storage (`session_evaluations` table)
2. `recordEvaluation(eval)` -- writes to SQLite with prompt style classification
3. `analyzePatterns()` -- SQL queries for project/prompt/duration/time patterns
4. Threshold check: only generate patterns when 50+ evaluations exist
5. `formatForContext()` -- cached pattern summary for AI context
6. Wire into evaluateSession() in index.js to dual-write (state + SQLite)
7. Wire into ContextAssembler for AI context
8. Test file
9. Update helpers.js with sessionLearner mock

---

## 9. Dependency Graph

```
PA-01 (Reminders)         -- independent, can start immediately
PA-02 (Conversations)     -- independent, can start immediately
PA-03 (Session MCP)       -- independent, can start immediately
PA-04 (Session Learning)  -- independent, can start immediately

All share orchestrator.db but with separate tables (no cross-table deps).
```

**Execution order recommendation:** 07-01 -> 07-02 -> 07-03 -> 07-04

Rationale:
- 07-01 (reminders) is the highest user-value feature and most self-contained
- 07-02 (conversations) improves the NL experience for all subsequent features
- 07-03 (session MCP) may be simpler than expected (user-scope MCP already works)
- 07-04 (learning) needs evaluation data to accumulate, so ship it last but let it start collecting

---

## 10. Key Design Decisions Needed

1. **Reminder timezone handling:** Always interpret times in `America/New_York`? Or let AI detect explicit timezone references?
   - **Recommendation:** Default to `America/New_York`, let AI handle explicit timezone mentions.

2. **Reminder firing during quiet hours:** Bypass quiet hours or queue?
   - **Recommendation:** Bypass. User explicitly requested the time.

3. **Conversation TTL:** 24h (current) vs 7 days vs indefinite?
   - **Recommendation:** 7 days, 100 message cap.

4. **Session MCP: `--allowedTools` or rely on user-scope?**
   - **Recommendation:** Rely on user-scope for now (already configured). Add `--mcp-config` only for project-specific needs.

5. **Learning threshold:** 50 evaluations (as specified) or configurable?
   - **Recommendation:** Configurable in config.json with default 50.

6. **Pattern analysis frequency:** Every evaluation, daily, or threshold-based?
   - **Recommendation:** Threshold-based (every 10 new evaluations).

---

## 11. Files Modified Summary

| File | PA-01 | PA-02 | PA-03 | PA-04 |
|------|-------|-------|-------|-------|
| `lib/reminder-manager.js` | NEW | | | |
| `lib/conversation-store.js` | | MODIFY | | |
| `lib/session-manager.js` | | | MODIFY | |
| `lib/session-learner.js` | | | | NEW |
| `lib/session-evaluator.js` | | | | MODIFY |
| `lib/context-assembler.js` | | ADD | ADD | ADD |
| `lib/commands.js` | MODIFY | MODIFY | | |
| `index.js` | MODIFY | MODIFY | | MODIFY |
| `config.json` | | ADD | | ADD |
| `test/reminder-manager.test.js` | NEW | | | |
| `test/conversation-store.test.js` | | MODIFY | | |
| `test/session-learner.test.js` | | | | NEW |
| `test/helpers.js` | ADD | | | ADD |

**New files:** 4 (2 lib + 2 test)
**Modified files:** ~10
**New npm dependencies:** 0 (constraint maintained)
