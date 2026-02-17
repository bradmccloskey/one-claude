# Architecture Patterns — v4.0 Integration Architecture

**Domain:** Extending an AI-powered Node.js orchestrator with session evaluation, MCP integrations, service health monitoring, event-driven patterns, and revenue tracking
**Researched:** 2026-02-16
**Confidence:** HIGH (based on full codebase analysis + verified docs)

---

## Executive Summary

The v3.0 orchestrator is a 13-module Node.js daemon with 4 concurrent loops (message polling 10s, proactive scan 60s, morning digest cron, AI think cycle 5min). It uses `claude -p` via `child_process.execSync` for AI reasoning, file-based state (`.state.json`), and tmux for session management. Two npm dependencies: `better-sqlite3` and `node-cron`.

v4.0 adds five new capabilities that integrate with this architecture. The key architectural decision is: **do NOT restructure the existing hub-and-spoke model**. Instead, add new data-gathering modules that feed into the existing context assembler, and new action modules that plug into the existing decision executor. The AI brain remains the single decision point.

The most important finding: **MCP tools ARE available in `claude -p` print mode** (fixed in Claude Code v0.2.54, current version is 2.1.39). The orchestrator can use `claude -p --allowedTools "mcp__github__tool_name"` to bridge from Node.js to MCP servers. This is the recommended approach for external integrations.

---

## Current Architecture (v3.0 — As Built)

```
                     +--------------------+
                     |     index.js       |
                     |     Main Loop      |
                     +--------+-----------+
                              |
           +------------------+------------------+------------------+
           |                  |                  |                  |
  pollMessages()       proactiveScan()      scheduler()      thinkCycle()
  (10s setInterval)    (60s setInterval)    (node-cron)      (5min setTimeout)
           |                  |                  |                  |
           v                  v                  v                  v
  +--------+-------+  +------+-------+  +-------+------+  +-------+-------+
  | messenger.js   |  | scanner.js   |  | scheduler.js |  | ai-brain.js   |
  | (iMessage JXA) |  | (STATE.md)   |  | (cron wrap)  |  | (claude -p)   |
  +--------+-------+  +------+-------+  +--------------+  +-------+-------+
           |                  |                                    |
           v                  v                            +-------+-------+
  +--------+-------+  +------+-------+                    | context-      |
  | commands.js    |  | signal-      |                    | assembler.js  |
  | (SMS router    |  | protocol.js  |                    | (prompt       |
  |  + AI NL)      |  | (file IPC)   |                    |  builder)     |
  +--------+-------+  +--------------+                    +-------+-------+
           |                                                      |
           v                                               +------+--------+
  +--------+-------+                                       | decision-     |
  | session-       |                                       | executor.js   |
  | manager.js     |                                       | (action       |
  | (tmux)         |                                       |  dispatch)    |
  +---------+------+                                       +------+--------+
            |                                                     |
  +---------+------+  +----------------+                   +------+--------+
  | process-       |  | notification-  |                   | Uses:         |
  | monitor.js     |  | manager.js     |                   | sessionMgr,   |
  | (ps aux)       |  | (tier routing) |                   | messenger,    |
  +----------------+  +----------------+                   | notifMgr      |
                                                           +---------------+
  +----------------+  +----------------+
  | state.js       |  | digest.js      |
  | (.state.json)  |  | (formatters)   |
  +----------------+  +----------------+
```

### Current Data Sources (What the AI Can See)

| Source | Module | Data | Freshness |
|--------|--------|------|-----------|
| Project state | scanner.js | .planning/STATE.md parsed fields | 60s poll |
| Session status | session-manager.js | tmux session list + signal files | On-demand |
| Process health | process-monitor.js | `ps aux` for claude processes | On-demand |
| Signal files | signal-protocol.js | .orchestrator/*.json | 60s poll |
| Decision history | state.js | Last 5 decisions from .state.json | In-memory |

### Current Actions (What the AI Can Do)

| Action | Module | How |
|--------|--------|-----|
| start | session-manager.js | `tmux new-session` + `claude --dangerously-skip-permissions` |
| stop | session-manager.js | `tmux send-keys C-c` + `tmux kill-session` |
| restart | session-manager.js | stop + start |
| notify | notification-manager.js | 4-tier SMS with batching |
| skip | decision-executor.js | Log and move on |

---

## v4.0 Target Architecture

### New Modules

| Module | File | Purpose | Depends On | Phase |
|--------|------|---------|------------|-------|
| **Session Evaluator** | `lib/session-evaluator.js` | Read tmux output, check git diffs, judge session quality | session-manager, child_process | Early |
| **Service Health Monitor** | `lib/health-monitor.js` | HTTP pings to running services, Docker container checks | native fetch, child_process | Early |
| **Revenue Tracker** | `lib/revenue-tracker.js` | Read revenue data, track earnings per project | fs (data files) | Mid |
| **Event Bus** | `lib/event-bus.js` | Internal pub/sub replacing some polling with push | EventEmitter (built-in) | Early |

### Modified Modules

| Module | Change | Why |
|--------|--------|-----|
| **context-assembler.js** | Add sections for session eval, health, revenue | New data sources feed into AI context |
| **decision-executor.js** | Add new action types: `check_health`, `evaluate_session`, `query_mcp` | New capabilities |
| **ai-brain.js** | Model routing (Haiku/Sonnet/Opus), MCP tool bridging, digest enhancement | Smarter decisions |
| **state.js** | Add health history, revenue data, conversation persistence | More persistent state |
| **config.json** | Add health endpoints, revenue sources, model routing rules | New configuration |
| **index.js** | Event bus integration, health check interval | New loops |

### Unchanged Modules

| Module | Why Unchanged |
|--------|--------------|
| **messenger.js** | SMS interface does not change |
| **scanner.js** | STATE.md scanning stays the same |
| **signal-protocol.js** | Signal file protocol stays the same |
| **process-monitor.js** | Process monitoring stays the same |
| **scheduler.js** | Cron scheduling stays the same |
| **digest.js** | Template formatter (AI digest already in ai-brain.js) |

---

## Feature Integration Details

### 1. Session Evaluation

**Problem:** The orchestrator starts sessions but has no idea if they produced good work. It only knows "session ran for X minutes."

**Where it fits:** New module `lib/session-evaluator.js` that sits alongside `session-manager.js`. Called by the AI brain during or after think cycles.

**Data flow:**

```
[tmux session running] --> session-evaluator reads output
                           |
                           +---> tmux capture-pane -t "orch-project" -p -S -200
                           |     (last 200 lines of terminal output)
                           |
                           +---> git -C /project/dir log --oneline -5
                           |     (recent commits since session started)
                           |
                           +---> git -C /project/dir diff --stat HEAD~3
                           |     (what files changed)
                           |
                           v
                    [Structured evaluation object]
                           |
                           v
                    [context-assembler adds to prompt]
                           |
                           v
                    [AI brain decides: continue, restart, stop, escalate]
```

**Implementation pattern:**

```javascript
class SessionEvaluator {
  constructor(config) {
    this.projectsDir = config.projectsDir;
  }

  /**
   * Evaluate a running session by reading its tmux output and git activity.
   * @param {string} projectName - e.g., "revenue/web-scraping-biz"
   * @param {string} sessionName - e.g., "orch-web-scraping-biz"
   * @returns {{ output: string, commits: string[], filesChanged: number, assessment: string }}
   */
  evaluate(projectName, sessionName) {
    const projectDir = path.join(this.projectsDir, projectName);

    // 1. Capture last N lines of tmux output
    let output = '';
    try {
      output = execSync(
        `tmux capture-pane -t "${sessionName}" -p -S -100`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
    } catch { /* session may not exist */ }

    // 2. Recent git commits (since session started)
    let commits = [];
    try {
      const log = execSync(
        `git -C "${projectDir}" log --oneline -5 --since="2 hours ago"`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      commits = log ? log.split('\n') : [];
    } catch {}

    // 3. File change stats
    let filesChanged = 0;
    try {
      const stat = execSync(
        `git -C "${projectDir}" diff --stat HEAD~3 2>/dev/null | tail -1`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      const match = stat.match(/(\d+) files? changed/);
      if (match) filesChanged = parseInt(match[1]);
    } catch {}

    // 4. Quick assessment (no AI needed)
    let assessment = 'unknown';
    if (output.includes('error') || output.includes('Error')) assessment = 'has-errors';
    else if (commits.length > 0) assessment = 'productive';
    else if (output.includes('Waiting') || output.includes('waiting')) assessment = 'stalled';
    else assessment = 'active';

    return {
      output: output.substring(0, 1000),  // Cap at 1K chars for context
      commits,
      filesChanged,
      assessment,
    };
  }
}
```

**Integration with context-assembler.js:**

Add a new section builder `_buildSessionEvalSection(sessions)` that calls `sessionEvaluator.evaluate()` for each active session. Include in the prompt as:

```
Session Evaluations:
- web-scraping-biz: productive (3 commits, 8 files changed)
  Recent: "feat: add screenshot endpoint"
- crypto-trader: stalled (0 commits, output shows "waiting for input")
```

**Integration with decision-executor.js:**

Add `evaluate_session` as a new allowed action the AI can request. When the AI says `"action": "evaluate_session", "project": "X"`, the executor calls `sessionEvaluator.evaluate(X)` and feeds results back.

**Key design decisions:**
- `tmux capture-pane -p -S -100` gets the last 100 lines without affecting the session
- Git operations use `--since` to scope to the session duration
- Cap output at 1000 chars to fit in context budget
- No new dependencies (uses tmux and git CLI)

---

### 2. MCP Integration Strategy

**Critical finding:** MCP tools ARE available in `claude -p` print mode since Claude Code v0.2.54. The current CLI version is 2.1.39. This was verified via the resolved GitHub issue #610 and the official CLI reference docs.

**The three approaches:**

| Approach | How | Pros | Cons |
|----------|-----|------|------|
| **(a) claude -p bridge** | Call `claude -p --allowedTools "mcp__github__tool"` | Zero new deps, uses existing MCP config, AI reasons about when to use tools | Adds 5-15s per claude -p call, single-threaded |
| **(b) Direct REST** | Call GitHub API, Docker API directly from Node.js | Fast, no AI overhead, parallel | New dependencies or complex native http, duplicates logic |
| **(c) Hybrid** | Direct REST for health checks, claude -p for complex queries | Best of both worlds | More code to maintain |

**Recommendation: Approach (c) — Hybrid**

Use direct Node.js calls for simple, high-frequency operations (health pings, Docker status). Use `claude -p` with MCP tools for complex, low-frequency operations (GitHub PR reviews, calendar lookups, creating issues).

**Rationale:**
- Health checks run every 60s. Spawning `claude -p` every 60s for an HTTP ping is wasteful.
- GitHub issue creation happens maybe once per think cycle. `claude -p` with MCP is perfect here.
- Docker container status can be read directly via `docker ps --format json`. No AI needed.
- Calendar/Reminders queries are inherently natural-language. `claude -p` with MCP is the right tool.

**MCP bridge implementation:**

```javascript
// In ai-brain.js or a new lib/mcp-bridge.js

/**
 * Ask Claude to use an MCP tool via claude -p with --allowedTools.
 * This bridges Node.js code to the user's configured MCP servers.
 *
 * @param {string} prompt - What to ask Claude to do
 * @param {string[]} tools - MCP tools to allow, e.g. ["mcp__github__create_issue"]
 * @returns {string} Claude's response text
 */
function queryMCP(prompt, tools, options = {}) {
  const allowedTools = tools.join(',');
  const model = options.model || 'sonnet';
  const timeout = options.timeout || 60000;

  return execSync(
    `claude -p --model ${model} --max-turns 3 --output-format text ` +
    `--allowedTools "${allowedTools}"`,
    { input: prompt, encoding: 'utf-8', timeout }
  ).trim();
}

// Usage examples:
// queryMCP("List open PRs for repo X", ["mcp__github__list_pull_requests"])
// queryMCP("What's on my calendar today?", ["mcp__google_calendar__list_events"])
// queryMCP("Check my Apple reminders", ["mcp__apple_mcp__list_reminders"])
```

**Available MCP servers (from user's ~/.claude.json):**

| Server Name | Key Tools | Use Case in Orchestrator |
|-------------|-----------|--------------------------|
| `github` | create_issue, list_pull_requests, get_file_contents | PR awareness, issue tracking, code quality |
| `google-calendar` | list_events, create_event | Schedule-aware decisions, meeting blocks |
| `apple-mcp` | list_reminders, create_reminder, search_notes | Task management, notes integration |
| `memory` | create_entities, search_nodes | Persistent knowledge graph across think cycles |
| `playwright` | navigate, screenshot | Web UI testing (used via sessions, not orchestrator directly) |
| `context7` | query-docs | Library documentation (used via sessions, not orchestrator directly) |

**What the AI brain gets in context:**

```
MCP Capabilities:
- GitHub: Can check PRs, issues, commits for any project
- Calendar: Can check today's schedule, block time
- Reminders: Can create/check Apple Reminders
- Memory: Can store/recall cross-session knowledge

Use MCP tools when: evaluating PR quality, checking if user is busy,
creating follow-up tasks, recalling project-specific context.
```

**Important constraint:** Only ONE `claude -p` call at a time (existing anti-pattern rule). MCP queries should be batched into the think cycle prompt or run sequentially, never in parallel.

---

### 3. Service Health Monitoring

**Problem:** The orchestrator manages services running on ports 7681, 8002, 8050, 8060, 8070, 8100 but has no idea if they're actually responding to requests.

**Where it fits:** New module `lib/health-monitor.js`. Runs on its own interval (configurable, default 5 min). Results feed into context-assembler.

**Data flow:**

```
[config.json health endpoints] --> health-monitor polls each
                                   |
                                   +--> fetch("http://localhost:8060/")
                                   +--> fetch("http://localhost:8100/health")
                                   +--> docker ps --format json (for containers)
                                   |
                                   v
                            [Health state object]
                                   |
                                   v
                            [state.js persists health history]
                                   |
                                   v
                            [context-assembler includes in prompt]
                                   |
                                   v
                            [AI brain decides: alert, restart, ignore]
```

**Implementation pattern:**

```javascript
class HealthMonitor {
  constructor(config) {
    this.endpoints = config.healthEndpoints || [];
    this.dockerEnabled = config.healthDocker || false;
    this._lastResults = {};
  }

  /**
   * Check all configured health endpoints.
   * Uses native fetch (Node.js 18+) for zero dependencies.
   * @returns {Object[]} Array of { name, url, status, responseMs, error }
   */
  async checkAll() {
    const results = [];

    // HTTP endpoint checks
    for (const ep of this.endpoints) {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(ep.url, {
          signal: controller.signal,
          method: 'GET',
        });
        clearTimeout(timeoutId);
        results.push({
          name: ep.name,
          url: ep.url,
          status: response.ok ? 'healthy' : 'unhealthy',
          httpStatus: response.status,
          responseMs: Date.now() - start,
        });
      } catch (err) {
        results.push({
          name: ep.name,
          url: ep.url,
          status: 'down',
          responseMs: Date.now() - start,
          error: err.name === 'AbortError' ? 'timeout' : err.message,
        });
      }
    }

    // Docker container checks
    if (this.dockerEnabled) {
      try {
        const output = execSync(
          'docker ps --format "{{.Names}}|{{.Status}}|{{.Ports}}" 2>/dev/null',
          { encoding: 'utf-8', timeout: 10000 }
        ).trim();
        for (const line of output.split('\n').filter(Boolean)) {
          const [name, status, ports] = line.split('|');
          results.push({
            name: `docker:${name}`,
            status: status.startsWith('Up') ? 'healthy' : 'unhealthy',
            detail: `${status} | ${ports}`,
          });
        }
      } catch {}
    }

    this._lastResults = results;
    return results;
  }

  getLastResults() { return this._lastResults; }
}
```

**Configuration addition to config.json:**

```json
{
  "health": {
    "enabled": true,
    "intervalMs": 300000,
    "endpoints": [
      { "name": "income-dashboard", "url": "http://localhost:8060/" },
      { "name": "site-monitor", "url": "http://localhost:8070/" },
      { "name": "mlx-api", "url": "http://localhost:8100/health" },
      { "name": "scraping-api", "url": "http://localhost:8002/health" },
      { "name": "ssh-terminal", "url": "http://localhost:7681/" },
      { "name": "project-dashboard", "url": "http://localhost:8050/" }
    ],
    "docker": true,
    "alertOnDown": true,
    "consecutiveFailsBeforeAlert": 2
  }
}
```

**Integration with context-assembler.js:**

New section `_buildHealthSection()`:

```
Service Health:
- income-dashboard: healthy (120ms)
- site-monitor: healthy (95ms)
- mlx-api: DOWN (timeout) [2 consecutive fails]
- scraping-api: healthy (200ms)
- Docker: 9/9 containers running
```

**Integration with decision-executor.js:**

New action `restart_service` that the AI can recommend. Initially just alerts the human (tier 2 notification). Later phases could add launchd restart capability.

**Zero new dependencies:** Uses native `fetch` (available in Node.js 18+, the system runs Node 24.x). Docker status via `docker ps` CLI.

---

### 4. Event-Driven Patterns

**Problem:** The current architecture polls everything. Signal files are polled every 60s. This means up to 60s latency on session signals.

**Recommended approach: Internal EventEmitter bus, NOT fs.watch**

**Why NOT fs.watch:**
- `fs.watch` on macOS has known reliability issues: duplicate events, missed events with some editors, most changes reported as `rename`
- Chokidar would fix this but adds a dependency (the project has only 2)
- The orchestrator watches files across 19 project directories. That's 19+ watchers needed
- Polling at 60s is good enough for STATE.md changes (projects don't change that fast)
- Signal files ARE latency-sensitive but only appear when sessions are active (low volume)

**What to use instead: Node.js EventEmitter as internal bus**

The real value of event-driven architecture here is not file watching. It is **decoupling the modules from the main loop**. Today, `proactiveScan()` is a monolithic function that calls scanner, signal-protocol, and session-manager sequentially. An event bus allows modules to emit events that other modules react to.

```javascript
const EventEmitter = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);
  }

  // Typed event helpers for documentation
  emitSignal(projectName, type, data) {
    this.emit('signal', { projectName, type, data, timestamp: Date.now() });
  }
  emitHealthChange(name, oldStatus, newStatus) {
    this.emit('health:change', { name, oldStatus, newStatus, timestamp: Date.now() });
  }
  emitSessionEvent(projectName, event, data) {
    this.emit('session', { projectName, event, data, timestamp: Date.now() });
  }
  emitRevenueUpdate(source, amount) {
    this.emit('revenue', { source, amount, timestamp: Date.now() });
  }
}
```

**How it integrates:**

```
index.js creates EventBus
    |
    +--> health-monitor.checkAll() emits 'health:change' when status changes
    +--> signal-protocol.scanSignals() emits 'signal' when new signal found
    +--> session-manager emits 'session' on start/stop/timeout
    |
    +--> AI brain LISTENS for events to adjust think timing
    |    (e.g., signal event triggers immediate think instead of waiting 5min)
    |
    +--> notification-manager LISTENS for urgent events
         (e.g., health:change DOWN triggers immediate tier-1 notification)
```

**Selective fs.watch (optional, phase 2):**

If latency on signal files becomes a real issue (user reports it), add fs.watch ONLY on `.orchestrator/` directories of ACTIVE sessions. Not all 19 projects, just the 1-5 with running sessions. This is a targeted, low-risk use of fs.watch.

```javascript
// In session-manager.js, when starting a session:
const watcher = fs.watch(signalDir, { persistent: false }, (event, filename) => {
  if (filename && filename.endsWith('.json')) {
    eventBus.emitSignal(projectName, filename.replace('.json', ''), null);
  }
});
// Store watcher, close it when session stops
```

**Key principle:** Event bus is internal architecture. File polling stays for reliability. fs.watch is an optional optimization for active sessions only.

---

### 5. Revenue Tracking

**Problem:** The orchestrator has no idea which projects generate revenue. It treats all 19 projects equally. Revenue-generating projects should get priority.

**Where it fits:** New module `lib/revenue-tracker.js`. Reads revenue data from JSON files (manually maintained or scraped). Data flows into context-assembler to influence AI prioritization.

**Data flow:**

```
[revenue-data.json] --> revenue-tracker reads on boot + periodic refresh
    |                   (or: reads from income-dashboard SQLite DB)
    |
    v
[Revenue state]
    |
    v
[context-assembler includes in prompt]
    |
    v
[AI brain weighs revenue when prioritizing]
```

**Implementation pattern:**

```javascript
class RevenueTracker {
  constructor(config) {
    this.dataFile = config.revenueDataFile || path.join(__dirname, '..', 'revenue-data.json');
    this._data = {};
  }

  load() {
    try {
      this._data = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
    } catch {
      this._data = {};
    }
    return this._data;
  }

  getProjectRevenue(projectName) {
    return this._data[projectName] || { monthly: 0, total: 0, source: 'none' };
  }

  getAllRevenue() {
    return this._data;
  }

  /**
   * Try to read from income-dashboard's SQLite DB for live data.
   * Falls back to static JSON file.
   */
  refreshFromDashboard() {
    const dbPath = '/Users/claude/projects/revenue/income-dashboard/data/income.db';
    if (!fs.existsSync(dbPath)) return;

    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      // Query depends on income-dashboard schema
      // This is a placeholder — actual query TBD after income-dashboard v1
      db.close();
    } catch {}
  }
}
```

**Revenue data file format (`revenue-data.json`):**

```json
{
  "revenue/web-scraping-biz": {
    "monthly": 150,
    "total": 450,
    "source": "RapidAPI + Fiverr",
    "trend": "growing"
  },
  "passive/mlx-inference-api": {
    "monthly": 0,
    "total": 0,
    "source": "RapidAPI (not launched)",
    "trend": "pre-revenue"
  },
  "passive/bandwidth-sharing": {
    "monthly": 12,
    "total": 85,
    "source": "9 Docker containers",
    "trend": "stable"
  },
  "passive/xmr-miner": {
    "monthly": 8,
    "total": 120,
    "source": "Mining pool",
    "trend": "stable"
  }
}
```

**Integration with context-assembler.js:**

New section `_buildRevenueSection()`:

```
Revenue Context:
- web-scraping-biz: $150/mo (growing) — RapidAPI + Fiverr
- bandwidth-sharing: $12/mo (stable) — Docker containers
- xmr-miner: $8/mo (stable) — Mining pool
- Total portfolio: ~$170/mo

Revenue-weighted priority: Prioritize web-scraping-biz issues over non-revenue projects.
```

**Zero new dependencies:** Uses existing `better-sqlite3` for income-dashboard integration, `fs.readFileSync` for JSON file.

---

### 6. Conversation Persistence

**Problem:** `commands.js` stores `_conversationHistory` in memory. Lost on restart.

**Where it fits:** Extend `state.js` to persist conversation history. Small change.

**Implementation:**

```javascript
// In state.js, add:
logConversation(state, entry) {
  if (!state.conversationHistory) state.conversationHistory = [];
  state.conversationHistory.push(entry);
  if (state.conversationHistory.length > 20) {
    state.conversationHistory = state.conversationHistory.slice(-20);
  }
  this.save(state);
}

getConversationHistory(state, count = 10) {
  return (state.conversationHistory || []).slice(-count);
}
```

**In commands.js, change:**
- Load conversation history from state on construction
- Save each conversation turn to state instead of only in-memory array
- Minor change, no new files needed

---

### 7. Multi-Model Routing

**Problem:** Every `claude -p` call uses Sonnet. Some tasks are simple (Haiku is fine), some are complex (Opus is better).

**Where it fits:** Inside `ai-brain.js`. Add model selection logic before the `execSync` call.

**Implementation:**

```javascript
// In ai-brain.js
_selectModel(context) {
  const { attentionCount, signalCount, sessionCount, evalNeeded } = context;

  // Complex situations: use Opus
  if (attentionCount > 3 || evalNeeded || signalCount > 2) {
    return 'opus';
  }

  // Routine monitoring: use Haiku (faster, lower resource)
  if (attentionCount === 0 && signalCount === 0 && sessionCount === 0) {
    return 'haiku';
  }

  // Default: Sonnet (good balance)
  return 'sonnet';
}
```

**Where in the pipeline:** Model selection happens at the START of `think()`, before calling `claude -p`. The model name is passed via `--model` flag. No architectural change needed.

**Natural language handler:** The `_handleNaturalLanguage()` in `commands.js` should also use model routing. Quick factual questions can use Haiku. Complex project analysis should use Sonnet.

---

## Complete v4.0 Architecture Diagram

```
                      +----------------------+
                      |      index.js        |
                      |      Main Loop       |
                      +----------+-----------+
                                 |
          +----------+-----------+-----------+-----------+
          |          |           |           |           |
   pollMessages  proactiveScan  scheduler  thinkCycle  healthCheck
   (10s)         (60s)         (cron)      (5min)      (5min)
          |          |           |           |           |
          v          v           v           v           v
  +-------+--+ +----+----+ +---+----+ +----+----+ +----+-----+
  |messenger | |scanner  | |schedule| |ai-brain | |health-   |
  |(iMessage)| |(STATE)  | |(cron)  | |(claude-p| |monitor   |
  +-------+--+ +----+----+ +--------+ | + MCP)  | |(fetch)   | <-- NEW
          |          |                 +----+----+ +----+-----+
          v          |                      |           |
  +-------+--+  +---+------+         +-----+-----+    |
  |commands  |  |signal-   |         |context-   |<---+
  |(router)  |  |protocol  |         |assembler  |<---+--- session-evaluator (NEW)
  +-------+--+  +----------+         |(+health   |<---+--- revenue-tracker (NEW)
          |                           | +eval     |
          v                           | +revenue) |
  +-------+--+   +----------+        +-----+-----+
  |session-  |   |event-bus |              |
  |manager   |   |(internal |        +-----+-----+
  |(tmux)    |   | EventEmit|        |decision-  |
  +-------+--+   | eter)    |        |executor   |
          |       +----+-----+        |(+new      |
  +-------+--+        |              | actions)  |
  |process-  |        |              +-----+-----+
  |monitor   |        |                    |
  |(ps aux)  |   Modules emit         Uses existing:
  +----------+   events to bus        sessionMgr,
                                      messenger,
  +----------+   +----------+        notifMgr,
  |state.js  |   |revenue-  |        + new:
  |(+convo   |   |tracker   |  <-- NEW  healthMon,
  | persist) |   |(JSON/DB) |           sessionEval
  +----------+   +----------+
                                   +----------+
  +----------+                     |session-  |
  |notif-    |                     |evaluator | <-- NEW
  |manager   |                     |(tmux +   |
  |(tiers)   |                     | git)     |
  +----------+                     +----------+
```

---

## New Data Flow: Think Cycle with v4.0 Enrichments

```
thinkCycle() fires (every 5min, or on event-bus trigger)
    |
    v
[context-assembler.assemble()]
    |
    +---> scanner.scanAll()                    (existing: project states)
    +---> sessionManager.getActiveSessions()   (existing: tmux sessions)
    +---> processMonitor.checkProjects()       (existing: ps aux)
    +---> state.load()                         (existing: decision history)
    +---> sessionEvaluator.evaluate()          (NEW: tmux output + git diffs)
    +---> healthMonitor.getLastResults()       (NEW: service status)
    +---> revenueTracker.getAllRevenue()        (NEW: revenue data)
    +---> state.getConversationHistory()       (NEW: recent SMS convo)
    |
    v
[Prompt built with all sections]
    |
    v
[_selectModel()] --> haiku/sonnet/opus based on complexity
    |
    v
[claude -p --model X --allowedTools "mcp__github__..."]
    |                                    ^
    |                                    |
    |  (AI can optionally use MCP tools during think cycle)
    |
    v
[Parse JSON response]
    |
    v
[decision-executor.evaluate() + execute()]
    |
    +---> start/stop/restart session    (existing)
    +---> notify human                  (existing)
    +---> evaluate_session              (NEW: trigger deeper eval)
    +---> check_health                  (NEW: trigger health check)
    +---> query_mcp                     (NEW: ask Claude to use MCP tool)
    +---> create_reminder               (NEW: Apple Reminders via MCP)
```

---

## MCP Integration Architecture (Detail)

### Why Hybrid (Direct + claude -p Bridge)

```
HIGH-FREQUENCY, SIMPLE           LOW-FREQUENCY, COMPLEX
(do directly in Node.js)         (use claude -p with MCP)

health-monitor.js:               ai-brain.js think cycle:
  fetch("http://localhost:8060")   "Check GitHub PRs for web-scraping-biz"
  docker ps --format json          --allowedTools "mcp__github__list_pull_requests"
  (every 5 min, <100ms each)      (every 5 min, 5-15s)

revenue-tracker.js:              commands.js natural language:
  fs.readFileSync(data.json)       "What's on my calendar today?"
  better-sqlite3 query             --allowedTools "mcp__google_calendar__list_events"
  (on boot + hourly)               (on-demand, 5-15s)

session-evaluator.js:            ai-brain.js session eval:
  tmux capture-pane                "Evaluate this session's git diff quality"
  git log --oneline                --allowedTools "mcp__github__get_file_contents"
  (per active session, <1s)        (when eval triggers, 5-15s)
```

### MCP Tool Naming Convention

The `--allowedTools` flag requires the format: `mcp__{serverName}__{toolName}`

Based on the user's configured MCP servers:

| Server | Tool Format | Example |
|--------|-------------|---------|
| github | `mcp__github__<tool>` | `mcp__github__list_pull_requests` |
| google-calendar | `mcp__google_calendar__<tool>` | `mcp__google_calendar__list_events` |
| apple-mcp | `mcp__apple_mcp__<tool>` | `mcp__apple_mcp__list_reminders` |
| memory | `mcp__memory__<tool>` | `mcp__memory__search_nodes` |

**Discovery:** The exact tool names need to be discovered at implementation time by running `claude -p --allowedTools "mcp__github__*"` or checking the MCP server documentation. The architecture supports any tool names.

---

## Config.json Extensions

```json
{
  "health": {
    "enabled": true,
    "intervalMs": 300000,
    "endpoints": [
      { "name": "income-dashboard", "url": "http://localhost:8060/" },
      { "name": "site-monitor", "url": "http://localhost:8070/" },
      { "name": "mlx-api", "url": "http://localhost:8100/health" },
      { "name": "scraping-api", "url": "http://localhost:8002/health" },
      { "name": "ssh-terminal", "url": "http://localhost:7681/" },
      { "name": "project-dashboard", "url": "http://localhost:8050/" }
    ],
    "docker": true,
    "consecutiveFailsBeforeAlert": 2
  },
  "revenue": {
    "enabled": true,
    "dataFile": "revenue-data.json",
    "refreshIntervalMs": 3600000,
    "dashboardDb": "/Users/claude/projects/revenue/income-dashboard/data/income.db"
  },
  "ai": {
    "models": {
      "routine": "haiku",
      "default": "sonnet",
      "complex": "opus"
    },
    "mcpBridge": {
      "enabled": true,
      "timeout": 60000,
      "maxTurns": 3
    },
    "sessionEvaluation": {
      "enabled": true,
      "captureLines": 100,
      "gitLogDepth": 5
    }
  }
}
```

---

## Build Order (Dependency-Aware)

The build order respects dependencies. Each item can only be built after its dependencies exist.

### Tier 1: Foundation (No dependencies on other new modules)

1. **Event Bus** (`lib/event-bus.js`)
   - Pure EventEmitter wrapper, no dependencies
   - Wire into index.js as shared instance
   - Other modules start emitting events as they're built

2. **Session Evaluator** (`lib/session-evaluator.js`)
   - Depends on: tmux (existing), git CLI (existing)
   - No dependency on other new modules
   - Can be tested standalone

3. **Health Monitor** (`lib/health-monitor.js`)
   - Depends on: native fetch, docker CLI
   - No dependency on other new modules
   - Can be tested standalone

4. **Conversation Persistence** (extend `state.js`)
   - Depends on: state.js (existing)
   - Small change, no new file

### Tier 2: Data Integration (Depends on Tier 1)

5. **Context Assembler Extensions** (modify `context-assembler.js`)
   - Depends on: session-evaluator, health-monitor
   - Add new section builders for eval, health, revenue data
   - Wire new modules as constructor dependencies

6. **Revenue Tracker** (`lib/revenue-tracker.js`)
   - Depends on: fs, better-sqlite3 (existing dep)
   - Create revenue-data.json with initial data
   - Wire into context-assembler

### Tier 3: Intelligence (Depends on Tier 2)

7. **Multi-Model Routing** (modify `ai-brain.js`)
   - Depends on: enriched context from Tier 2
   - Add `_selectModel()` method
   - Change `execSync` call to use selected model

8. **MCP Bridge** (in `ai-brain.js` or new `lib/mcp-bridge.js`)
   - Depends on: claude -p with --allowedTools
   - Add `queryMCP()` utility function
   - AI brain can request MCP tools during think cycle

9. **Decision Executor Extensions** (modify `decision-executor.js`)
   - Depends on: session-evaluator, health-monitor, MCP bridge
   - Add new action types: evaluate_session, check_health, query_mcp
   - Wire new modules as constructor dependencies

### Tier 4: Autonomy (Depends on Tier 3)

10. **Graduated Autonomy Rollout**
    - Depends on: session evaluation (to verify AI is making good decisions)
    - Move from observe to cautious with guardrails
    - Use session evaluation as safety metric

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Making MCP Calls from Node.js Directly
Do NOT install the `@modelcontextprotocol/sdk` package and run MCP clients from Node.js. This adds significant complexity and a new dependency. Use `claude -p` as the bridge instead. The user already has MCP servers configured and working.

### Anti-Pattern 2: fs.watch on All Project Directories
Do NOT set up fs.watch on all 19 project directories. Use it ONLY on active session `.orchestrator/` directories if needed, and only after polling proves too slow.

### Anti-Pattern 3: Database for Everything
Do NOT replace `.state.json` with SQLite for orchestrator state. The current file-based approach works. SQLite is only justified if state operations become a bottleneck (they won't at this scale). Revenue data CAN use SQLite via income-dashboard's existing DB.

### Anti-Pattern 4: Parallel claude -p Calls
Do NOT run multiple `claude -p` calls concurrently. Each call spawns a full Claude Code process. The Mac Mini has limited RAM (the system checks for 256MB free). Queue all AI calls through a single serialized pipeline.

### Anti-Pattern 5: Over-Instrumenting the Think Cycle
Do NOT run session evaluation on every think cycle for every session. Only evaluate sessions that have been running for more than a configurable threshold (e.g., 15 minutes) or that the AI specifically requests evaluation for.

### Anti-Pattern 6: Making Health Checks Block the Think Cycle
Health checks should run on their own interval, store results, and the context assembler reads the stored results. Do NOT run health checks synchronously inside the think cycle.

---

## Scalability Considerations

| Concern | At 5 projects | At 19 projects (current) | At 50 projects |
|---------|---------------|--------------------------|----------------|
| Context size | ~500 tokens | ~2000 tokens | ~5000 tokens (may need truncation) |
| Scan time | <100ms | <500ms | ~1s (still fine) |
| Health checks | 5 fetches | 6 endpoints + docker | Need pagination |
| Think cycle | 5-10s | 10-20s | 20-40s (may need model downgrade) |
| State file | ~10KB | ~50KB | ~200KB (may need rotation) |

The current architecture scales well to 50+ projects. The bottleneck is context window size for the AI prompt, not compute. Context truncation is already implemented at 8000 chars.

---

## Sources

- Codebase analysis of all 13 existing modules — HIGH confidence
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference) — HIGH confidence (verified --allowedTools, --mcp-config, print mode flags)
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp) — HIGH confidence (verified MCP configuration, scopes, tool naming)
- [GitHub Issue #610: MCP in Print Mode](https://github.com/anthropics/claude-code/issues/610) — HIGH confidence (confirmed FIXED in v0.2.54, current v2.1.39)
- [tmux Advanced Use](https://github.com/tmux/tmux/wiki/Advanced-Use) — HIGH confidence (capture-pane -p -S flags)
- [Node.js fs.watch vs chokidar](https://github.com/paulmillr/chokidar) — MEDIUM confidence (WebSearch verified)
- [Health Check Endpoint Pattern](https://microservices.io/patterns/observability/health-check-api.html) — HIGH confidence
- User's `~/.claude.json` MCP server configuration — HIGH confidence (directly read)
